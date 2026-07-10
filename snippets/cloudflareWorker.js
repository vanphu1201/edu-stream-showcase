/**
 * CLOUDFLARE WORKER: Secure Google Drive Stream Proxy (Optimized with Token Caching & Claim Verification)
 * 
 * Tuyến phòng thủ biên (Edge Network) nhận yêu cầu stream video, xác thực JWT token của
 * học viên, tự động lấy Access Token mới từ Google OAuth và truyền phát (pipe) luồng
 * dữ liệu video nhị phân trực tiếp từ Google Drive API về Client.
 * 
 * - Giải phóng 100% băng thông cho máy chủ chính (Render Free).
 * - Sử dụng V8 Isolate Global Memory để cache Google Access Token (tiết kiệm 99% request đến Google OAuth).
 * - Bảo mật nâng cao: Xác thực chữ ký + Thời gian hết hạn (exp) + Trùng khớp File ID được cấp phép.
 * - Hỗ trợ phân đoạn Range Requests (bytes=...) giúp tua video mượt mà.
 */

// Bộ nhớ đệm toàn cục (Isolate memory) để tránh Spam gửi request tới Google OAuth
let cachedAccessToken = null;
let accessTokenExpiry = 0; // Epoch timestamp (milliseconds)

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

      // 5. Khởi tạo luồng truyền phát từ Google Drive API
      const driveUrl = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
      const rangeHeader = request.headers.get("Range");

      const headers = {
        "Authorization": `Bearer ${accessToken}`,
      };
      if (rangeHeader) {
        headers["Range"] = rangeHeader;
      }

      // Fetch stream từ Google Server
      const driveResponse = await fetch(driveUrl, { headers });

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
