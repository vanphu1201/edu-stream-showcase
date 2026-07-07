const Order = require('../models/Order');
const User = require('../models/User');
const Course = require('../models/Course');

/**
 * Helper sinh mã QR chuyển khoản VietQR dựa trên tích hợp cổng SePay
 */
const buildQrUrl = (amount, content) => {
  const bank = process.env.BANK_NAME || 'MBBank';
  const acc = process.env.BANK_ACCOUNT_NUMBER || '123456789';
  return `https://qr.sepay.vn/img?bank=${bank}&acc=${acc}&template=compact2&amount=${amount}&des=${content}`;
};

/**
 * POST /api/payment/create-order
 * Tạo đơn hàng mới và trả về mã QR thanh toán nhanh
 */
exports.createOrder = async (req, res) => {
  try {
    const { courseIds } = req.body;
    const userId = req.user.id;

    if (!courseIds || !Array.isArray(courseIds) || courseIds.length === 0) {
      return res.status(400).json({ message: 'Vui lòng cung cấp danh sách khóa học.' });
    }

    // 1. Tính toán tổng số tiền dựa trên giá gốc cấu hình của các khóa học
    const courses = await Course.find({ _id: { $in: courseIds } });
    const totalAmount = courses.reduce((sum, course) => sum + (course.price || 0), 0);

    // 2. Sinh mã đơn hàng ngẫu nhiên định dạng duy nhất (LMS + 6 ký tự viết hoa)
    const orderCode = 'LMS' + Math.random().toString(36).substring(2, 8).toUpperCase();

    // 3. Khởi tạo đơn hàng vào DB
    const order = new Order({
      orderCode,
      userId,
      courseIds,
      amount: totalAmount,
      status: 'pending',
    });
    await order.save();

    // 4. Trả về thông tin chuyển khoản kèm theo mã QR VietQR tự động sinh
    res.status(201).json({
      orderCode,
      amount: totalAmount,
      qrUrl: buildQrUrl(totalAmount, orderCode),
      bankName: process.env.BANK_DISPLAY_NAME || 'Ngan Hang Quan Doi (MB)',
      bankAccount: process.env.BANK_ACCOUNT_NUMBER,
      bankAccountName: process.env.BANK_ACCOUNT_NAME
    });

  } catch (error) {
    res.status(500).json({ message: 'Không thể khởi tạo đơn hàng thanh toán.', error: error.message });
  }
};

/**
 * POST /api/payment/webhook
 * Nhận thông báo giao dịch chuyển khoản thời gian thực từ SePay để tự động kích hoạt
 */
exports.sepayWebhook = async (req, res) => {
  try {
    // 1. Xác thực apikey trong request header bảo mật webhook
    const apiKey = req.get('apikey') || req.get('authorization')?.replace(/bearer /i, '');
    if (!apiKey || apiKey !== process.env.SEPAY_WEBHOOK_APIKEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized webhook request' });
    }

    const { content, transferAmount, id, gateway } = req.body;
    if (!content || !transferAmount) {
      return res.status(200).json({ success: true, message: 'Thiếu dữ liệu giao dịch' });
    }

    // 2. Tìm mã đơn hàng có cấu trúc LMSxxxxxx trong nội dung chuyển khoản
    const orderCodeMatch = content.match(/LMS[A-Z0-9]{6}/);
    if (!orderCodeMatch) {
      return res.status(200).json({ success: true, message: 'Nội dung chuyển khoản không khớp mẫu LMS' });
    }
    const orderCode = orderCodeMatch[0];

    // 3. Tìm đơn hàng đang chờ thanh toán tương ứng
    const order = await Order.findOne({ orderCode, status: 'pending' });
    if (!order) {
      return res.status(200).json({ success: true, message: 'Không tìm thấy đơn hàng chờ xử lý' });
    }

    // 4. Đối soát số tiền (cho phép sai số nhỏ để chống lỗi làm tròn)
    if (Math.abs(transferAmount - order.amount) > 1000) {
      return res.status(200).json({ success: true, message: 'Số tiền chuyển khoản không khớp hóa đơn' });
    }

    // 5. Cập nhật trạng thái đơn hàng đã thanh toán
    order.status = 'paid';
    order.paidAt = new Date();
    order.transactionId = String(id);
    order.gateway = gateway || 'SEPAY';
    await order.save();

    // 6. Kích hoạt khóa học và cập nhật vào danh sách sở hữu của học viên
    await User.findByIdAndUpdate(order.userId, {
      $addToSet: { purchasedCourses: { $each: order.courseIds } }
    });

    console.log(`[Webhook success] Activated order ${orderCode} for User ID ${order.userId}`);
    res.status(200).json({ success: true });

  } catch (error) {
    console.error('[Webhook error]', error.message);
    res.status(200).json({ success: true, error: error.message }); // Luôn trả 200 để tránh SePay gửi lại liên tục khi xảy ra lỗi cục bộ
  }
};

/**
 * POST /api/payment/mock-pay
 * Demo kích hoạt nhanh khóa học phục vụ nhà tuyển dụng thử nghiệm (Bypass SePay)
 */
exports.mockPay = async (req, res) => {
  try {
    const { orderCode } = req.body;
    const userId = req.user.id;

    const order = await Order.findOne({ orderCode, userId, status: 'pending' });
    if (!order) {
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng chờ xử lý.' });
    }

    // Tự động duyệt đơn hàng trực tiếp
    order.status = 'paid';
    order.paidAt = new Date();
    order.transactionId = 'MOCK-' + Math.random().toString(36).substring(2, 11).toUpperCase();
    order.gateway = 'DEMO_BYPASS';
    await order.save();

    // Đồng bộ tức thì quyền truy cập khóa học cho học viên
    await User.findByIdAndUpdate(userId, {
      $addToSet: { purchasedCourses: { $each: order.courseIds } }
    });

    res.status(200).json({
      success: true,
      message: 'Kích hoạt khóa học thành công thông qua cổng thanh toán thử nghiệm.'
    });

  } catch (error) {
    res.status(500).json({ message: 'Lỗi kích hoạt đơn hàng demo.', error: error.message });
  }
};
