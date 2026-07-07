'use client';
import { createContext, useContext, useState, useEffect } from 'react';

const CartContext = createContext();

export const useCart = () => useContext(CartContext);

/**
 * CartProvider quản lý danh sách sản phẩm trong giỏ hàng, đồng bộ hóa 
 * liên tục sang LocalStorage để tránh bị mất khi refresh lại trang.
 */
export const CartProvider = ({ children }) => {
  const [cart, setCart] = useState([]);

  // 1. Khởi tạo trạng thái giỏ hàng từ LocalStorage khi khởi chạy ứng dụng
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedCart = localStorage.getItem('es_cart');
      if (savedCart) {
        try {
          setCart(JSON.parse(savedCart));
        } catch (e) {
          console.error('Lỗi phân giải giỏ hàng:', e);
        }
      }
    }
  }, []);

  // 2. Thêm khóa học vào giỏ hàng (Chống trùng lặp khóa học đã có)
  const addToCart = (course) => {
    if (!course || !course._id) return false;
    
    // Kiểm tra xem sản phẩm đã tồn tại hay chưa
    const alreadyExists = cart.some(item => item._id === course._id);
    if (alreadyExists) return false;

    const newCart = [...cart, course];
    setCart(newCart);
    localStorage.setItem('es_cart', JSON.stringify(newCart));

    // Kích hoạt sự kiện để Navbar nhận biết thay đổi lập tức
    window.dispatchEvent(new Event('storage'));
    return true;
  };

  // 3. Xóa sản phẩm khỏi giỏ hàng
  const removeFromCart = (courseId) => {
    const newCart = cart.filter(item => item._id !== courseId);
    setCart(newCart);
    localStorage.setItem('es_cart', JSON.stringify(newCart));
    window.dispatchEvent(new Event('storage'));
  };

  // 4. Xóa sạch giỏ hàng (Sau khi thanh toán xong)
  const clearCart = () => {
    setCart([]);
    localStorage.removeItem('es_cart');
    window.dispatchEvent(new Event('storage'));
  };

  // 5. Kiểm tra nhanh xem sản phẩm đã nằm trong giỏ hàng hay chưa
  const isInCart = (courseId) => {
    return cart.some(item => item._id === courseId);
  };

  return (
    <CartContext.Provider value={{
      cart,
      addToCart,
      removeFromCart,
      clearCart,
      isInCart
    }}>
      {children}
    </CartContext.Provider>
  );
};
