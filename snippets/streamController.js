const { google } = require('googleapis');
const Lesson = require('../models/Lesson');
const User = require('../models/User');
const { getActiveDriveNode, rotateNode } = require('../config/googleManager');

/**
 * GET /api/stream/:courseId/:videoId
 * Trình phát video bảo mật: Đọc luồng dữ liệu từ Google Drive API và chuyển tiếp cho client.
 * Hỗ trợ các yêu cầu Range Header để tua video (forward/rewind) mượt mà trên trình duyệt.
 */
exports.streamVideo = async (req, res) => {
  try {
    const { courseId, videoId } = req.params;
    const userId = req.user.id;

    // 1. Xác thực quyền sở hữu khóa học của học viên
    const user = await User.findById(userId);
    const isOwner = user && user.purchasedCourses.some(id => id.toString() === courseId);
    const isAdmin = user && user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Bạn chưa mua khóa học này hoặc quyền truy cập đã hết hạn." });
    }

    // 2. Kiểm tra sự tồn tại của bài học/video
    const lesson = await Lesson.findOne({ videoId });
    if (!lesson) {
      return res.status(404).json({ message: "Không tìm thấy tài nguyên video được yêu cầu." });
    }

    // 3. Lấy node Google Drive API hoạt động hiện tại (Hỗ trợ cân bằng tải tránh giới hạn Quota)
    let driveNode = getActiveDriveNode();
    let drive = google.drive({ version: 'v3', auth: driveNode.auth });

    // 4. Lấy siêu dữ liệu metadata của file video để biết tổng dung lượng (size)
    let metadata;
    try {
      metadata = await drive.files.get({
        fileId: videoId,
        fields: 'size, mimeType, name'
      });
    } catch (err) {
      console.warn(`[Stream Engine] Node [${driveNode.id}] lỗi quota hoặc file bị chặn. Đang tự động đổi node...`);
      driveNode = rotateNode(); // Xoay chuyển sang Google API Node dự phòng
      drive = google.drive({ version: 'v3', auth: driveNode.auth });
      metadata = await drive.files.get({
        fileId: videoId,
        fields: 'size, mimeType, name'
      });
    }

    const fileSize = parseInt(metadata.data.size, 10);
    const mimeType = metadata.data.mimeType || 'video/mp4';
    const range = req.headers.range;

    // 5. Nếu trình duyệt yêu cầu Range Header (Tua video)
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
      });

      // Tạo luồng đọc từ Drive API tương ứng với khoảng bytes yêu cầu
      const driveResponse = await drive.files.get(
        { fileId: videoId, alt: 'media' },
        { 
          headers: { Range: `bytes=${start}-${end}` },
          responseType: 'stream' 
        }
      );

      driveResponse.data.on('error', (err) => {
        console.error('[Stream Range Error]', err.message);
      });

      driveResponse.data.pipe(res);

    } else {
      // 6. Nếu trình duyệt tải toàn bộ video
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
      });

      const driveResponse = await drive.files.get(
        { fileId: videoId, alt: 'media' },
        { responseType: 'stream' }
      );

      driveResponse.data.pipe(res);
    }

  } catch (error) {
    console.error("[Stream Controller Fatal Error]", error.message);
    if (!res.headersSent) {
      res.status(500).json({ message: "Lỗi luồng truyền phát video.", error: error.message });
    }
  }
};
