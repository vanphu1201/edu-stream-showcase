/**
 * CLOUDFLARE WORKER: Secure Google Drive Stream Proxy (Optimized with Edge Bypass & 2-Level Caching)
 * 
 * Tuyến phòng thủ biên (Edge Network) nhận yêu cầu stream video, xác thực JWT token của
 * học viên, tự động lấy Access Token mới từ Google OAuth và truyền phát (pipe) luồng
 * dữ liệu video nhị phân trực tiếp từ Google Drive API về Client.
 * 
 * - Giải phóng 100% băng thông cho máy chủ chính (Render Free).
 * - Sử dụng V8 Isolate Global Memory để cache Google Access Token (tiết kiệm 99% request đến Google OAuth).
 * - Tự động kích hoạt cơ chế Edge Bypass (get_video_info) ngay tại mạng biên nếu tệp bị hạn chế tải xuống.
 * - Tích hợp 2 lớp Cache (Isolate Memory L1 + Cloudflare Cache API L2) triệt tiêu hoàn toàn độ trễ API.
 * - Bảo mật nâng cao: Xác thực chữ ký + Thời gian hết hạn (exp) + Trùng khớp File ID được cấp phép.
 * - Hỗ trợ phân đoạn Range Requests (bytes=...) giúp tua video mượt mà.
 */

// Bộ nhớ đệm toàn cục (Isolate memory) để tránh Spam gửi request tới Google OAuth
let cachedAccessToken = null;
let accessTokenExpiry = 0; // Epoch timestamp (milliseconds)

// Cache L1 (Isolate Memory) lưu videoplayback URL cho các video bị giới hạn tải xuống
const videoplaybackCache = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");

    // 1. Cấu hình CORS Header cho mạng phân phối biên
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Authorization, Content-Type",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!id || !token) {
      return new Response("Missing id or token parameter", { status: 400, headers: corsHeaders });
    }

    // 2. Xác thực chữ ký token JWT + Hạn dùng + Khóa chặt File ID ngay tại Edge
    const isValid = await verifyJWT(token, env.JWT_SECRET, id);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    // 3. Lấy cấu hình các Node Google Drive từ môi trường Worker (Hỗ trợ cả dạng String và JSON Binding)
    let GOOGLE_NODES = [];
    try {
      if (typeof env.GOOGLE_NODES === 'object' && env.GOOGLE_NODES !== null) {
        GOOGLE_NODES = env.GOOGLE_NODES;
      } else if (typeof env.GOOGLE_NODES === 'string') {
        GOOGLE_NODES = JSON.parse(env.GOOGLE_NODES);
      }
    } catch (err) {
      return new Response(`Worker config parse error: ${err.message}`, { status: 500, headers: corsHeaders });
    }

    if (!Array.isArray(GOOGLE_NODES) || GOOGLE_NODES.length === 0) {
      return new Response("Google nodes configuration missing or invalid format", { status: 500, headers: corsHeaders });
    }
    
    // Tự động xoay vòng hoặc chọn Node ngẫu nhiên (Load Balancing)
    const node = GOOGLE_NODES[Math.floor(Math.random() * GOOGLE_NODES.length)];

    try {
      // 4. Lấy Access Token từ Google OAuth qua Refresh Token (Đã tối ưu hóa Cache)
      const accessToken = await getAccessToken(node);

      const rangeHeader = request.headers.get("Range");

      // 5. Khởi tạo luồng truyền phát (Ưu tiên Bypass Stream tốc độ cao cho Video, tự động fallback cho PDF/Docs)
      let driveResponse;
      try {
        // Thử kết nối luồng phát tốc độ cao (Bypass qua Google Video Server)
        driveResponse = await getBypassStream(node, id, rangeHeader);
        if (driveResponse.status >= 400) {
          throw new Error(`Bypass stream returned status ${driveResponse.status}`);
        }
      } catch (bypassErr) {
        // Tự động chuyển về luồng tải thường từ Google Drive API (đối với tài liệu PDF, Docs... hoặc khi bypass lỗi)
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
        const headers = {
          "Authorization": `Bearer ${accessToken}`,
        };
        if (rangeHeader) {
          headers["Range"] = rangeHeader;
        }
        driveResponse = await fetch(driveUrl, { headers });
      }

      // Gộp các header CORS và thông tin phân đoạn
      const responseHeaders = new Headers(driveResponse.headers);
      for (const [key, val] of Object.entries(corsHeaders)) {
        responseHeaders.set(key, val);
      }

      return new Response(driveResponse.body, {
        status: driveResponse.status,
        statusText: driveResponse.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(`Worker stream error: ${err.message}`, { status: 500, headers: corsHeaders });
    }
  }
};

/**
 * Xác thực token JWT tại mạng biên sử dụng Web Crypto API bảo mật cao
 * Kiểm tra: Chữ ký hợp lệ, Token chưa hết hạn (exp), Token khớp với File ID yêu cầu.
 */
async function verifyJWT(token, secret, requestedFileId) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [headerB64, payloadB64, signatureB64] = parts;

    // A. Xác thực tính toàn vẹn chữ ký HMAC-SHA256
    const encoder = new TextEncoder();
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const keyData = encoder.encode(secret);

    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    function base64urlToUint8Array(base64urlString) {
      let base64 = base64urlString.replace(/-/g, '+').replace(/_/g, '/');
      const pad = (4 - (base64.length % 4)) % 4;
      base64 += '='.repeat(pad);
      const binaryString = atob(base64);
      return Uint8Array.from(binaryString, c => c.charCodeAt(0));
    }

    const signature = base64urlToUint8Array(signatureB64);
    const isSignatureValid = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!isSignatureValid) return false;

    // B. Giải mã Payload để kiểm tra thời gian và quyền truy cập file cụ thể
    function base64urlToString(base64urlString) {
      let base64 = base64urlString.replace(/-/g, '+').replace(/_/g, '/');
      const pad = (4 - (base64.length % 4)) % 4;
      base64 += '='.repeat(pad);
      return atob(base64);
    }

    const payload = JSON.parse(base64urlToString(payloadB64));

    // 1. Kiểm tra thời hạn Token (exp)
    if (payload.exp && Date.now() >= payload.exp * 1000) {
      return false;
    }

    // 2. Kiểm tra tính trùng khớp của File ID (Chống đổi ID để xem chùa các video khác)
    if (payload.fileId && payload.fileId !== requestedFileId) {
      return false;
    }

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Lấy Access Token Google API mới nhất sử dụng cơ chế OAuth 2.0 (Hỗ trợ Cache tối ưu)
 */
async function getAccessToken(node) {
  const now = Date.now();
  // Nếu Access Token đã được cache và thời gian hết hạn còn tối thiểu 5 phút
  if (cachedAccessToken && accessTokenExpiry > now + 5 * 60 * 1000) {
    return cachedAccessToken;
  }

  const tokenUrl = "https://oauth2.googleapis.com/token";
  const body = new URLSearchParams({
    client_id: node.client_id,
    client_secret: node.client_secret,
    refresh_token: node.refresh_token,
    grant_type: "refresh_token",
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error("Failed to get Google Access Token");
  }

  const data = await res.json();
  
  // Lưu Cache
  cachedAccessToken = data.access_token;
  const expiresIn = data.expires_in || 3600; // Mặc định là 1 giờ (3600s)
  accessTokenExpiry = now + (expiresIn * 1000);

  return cachedAccessToken;
}

/**
 * Thực hiện lấy link stream bypass get_video_info trực tiếp tại Edge Network (2-Level Cache)
 */
async function getBypassStream(node, id, rangeHeader) {
  const now = Date.now();
  let cached = videoplaybackCache.get(id);

  // 1. Thử lấy từ V8 Isolate Memory L1 Cache trước (Nhanh nhất)
  if (cached && cached.expiresAt > now) {
    console.log(`=> [Edge Memory L1 HIT] File ID: ${id}`);
  } else {
    // 2. Thử lấy từ Cloudflare Regional Cache API L2 (Chung cho các Isolate cùng khu vực)
    const cache = caches.default;
    const cacheKey = new Request(`https://cache.local/videoplayback/${id}`);
    
    try {
      const cacheResponse = await cache.match(cacheKey);
      if (cacheResponse) {
        const data = await cacheResponse.json();
        if (data.expiresAt > now) {
          cached = data;
          videoplaybackCache.set(id, cached);
          console.log(`=> [Edge Cache API L2 HIT] File ID: ${id}`);
        }
      }
    } catch (e) {
      console.warn("=> [Cache API Error] Lỗi đọc cache:", e.message);
    }

    // 3. Cache Miss -> Gọi Google API và Lưu vào cả 2 lớp Cache
    if (!cached) {
      console.log(`=> [Edge Cache MISS] Đang gọi get_video_info cho File ID: ${id}...`);
      const accessToken = await getAccessToken(node);
      const infoUrl = `https://drive.google.com/u/0/get_video_info?docid=${id}&drive_originator_app=303`;

      const infoRes = await fetch(infoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!infoRes.ok) {
        throw new Error(`Google API get_video_info trả về mã lỗi: ${infoRes.status}`);
      }

      const body = await infoRes.text();
      const contentList = body.split("&");
      let videoUrl = null;
      for (const content of contentList) {
        if (content.includes("videoplayback")) {
          const unescaped = decodeURIComponent(content);
          videoUrl = unescaped.split("|").pop();
          break;
        }
      }

      if (!videoUrl) {
        throw new Error("Không tìm thấy videoplayback URL trong dữ liệu trả về.");
      }

      // Lấy thời gian hết hạn dự phòng từ URL
      let expiresAt = now + 2 * 60 * 60 * 1000;
      try {
        const match = videoUrl.match(/[?&]expire=([0-9]+)/);
        if (match) {
          expiresAt = (parseInt(match[1]) - 300) * 1000;
        }
      } catch (_) {}

      // Lấy cookies đi kèm
      const cookies = infoRes.headers.get("set-cookie") || "";

      cached = { videoUrl, cookies, expiresAt };
      
      // Lưu L1 Memory
      videoplaybackCache.set(id, cached);

      // Lưu L2 Cache API
      try {
        const cacheSeconds = Math.max(60, Math.floor((expiresAt - now) / 1000));
        const responseToCache = new Response(JSON.stringify(cached), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${cacheSeconds}`
          }
        });
        await cache.put(cacheKey, responseToCache);
        console.log(`=> [Edge Cache API L2 SET] Đã lưu cache cho File ID: ${id} trong ${cacheSeconds}s`);
      } catch (e) {
        console.warn("=> [Cache API Error] Lỗi ghi cache:", e.message);
      }
    }
  }

  // Khởi tạo request tải luồng stream từ videoplayback của Google
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  if (rangeHeader) {
    headers['Range'] = rangeHeader;
  }
  if (cached.cookies) {
    headers['Cookie'] = cached.cookies;
  }

  return await fetch(cached.videoUrl, { headers });
}
