/**
 * CLOUDFLARE WORKER: Secure Google Drive Stream Proxy
 * 
 * Tuyến phòng thủ biên (Edge Network) nhận yêu cầu stream video, xác thực JWT token của
 * học viên, tự động lấy Access Token mới từ Google OAuth và truyền phát (pipe) luồng
 * dữ liệu video nhị phân trực tiếp từ Google Drive API về Client.
 * 
 * - Giải phóng 100% băng thông cho máy chủ chính (Render Free).
 * - Ẩn hoàn toàn ID tài khoản và cấu hình Google Drive Node.
 * - Hỗ trợ phân đoạn Range Requests (bytes=...) giúp tua video mượt mà.
 */

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

    // 2. Xác thực chữ ký token JWT ngay tại Edge (sử dụng Web Crypto API)
    const isValid = await verifyJWT(token, env.JWT_SECRET);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    // 3. Lấy cấu hình các Node Google Drive từ môi trường Worker
    const GOOGLE_NODES = JSON.parse(env.GOOGLE_NODES || "[]");
    if (GOOGLE_NODES.length === 0) {
      return new Response("Google nodes configuration missing", { status: 500, headers: corsHeaders });
    }
    
    // Tự động xoay vòng hoặc chọn Node ngẫu nhiên (Load Balancing)
    const node = GOOGLE_NODES[Math.floor(Math.random() * GOOGLE_NODES.length)];

    try {
      // 4. Lấy Access Token từ Google OAuth qua Refresh Token của Node
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
 */
async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [headerB64, payloadB64, signatureB64] = parts;

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
    return await crypto.subtle.verify("HMAC", key, signature, data);
  } catch (e) {
    return false;
  }
}

/**
 * Lấy Access Token Google API mới nhất sử dụng cơ chế OAuth 2.0
 */
async function getAccessToken(node) {
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
  return data.access_token;
}
