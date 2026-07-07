'use client';
import { createContext, useState, useEffect } from 'react';

export const AuthContext = createContext();

/**
 * AuthProvider lưu trữ trạng thái đăng nhập JWT của học viên.
 * Đồng thời tự động đồng bộ hồ sơ cá nhân và quyền sở hữu khóa học mới nhất từ server ở chế độ nền.
 */
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  // 1. Hàm đồng bộ hồ sơ học viên từ API về State & LocalStorage
  const refreshUser = async (authToken) => {
    const activeToken = authToken || token;
    if (!activeToken) return null;
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5002';
      const response = await fetch(`${apiUrl}/api/auth/me`, {
        headers: {
          'Authorization': `Bearer ${activeToken}`
        }
      });
      if (response.ok) {
        const updatedUser = await response.json();
        setUser(updatedUser);
        localStorage.setItem('user', JSON.stringify(updatedUser));
        return updatedUser;
      }
    } catch (err) {
      console.error("Lỗi đồng bộ thông tin tài khoản:", err);
    }
    return null;
  };

  // 2. Khôi phục phiên làm việc khi người dùng F5 hoặc mở lại trình duyệt
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const storedToken = localStorage.getItem('token');
      const storedUser = localStorage.getItem('user');
      if (storedToken) {
        setToken(storedToken);
        if (storedUser) {
          setUser(JSON.parse(storedUser));
        }
        // Gọi API đồng bộ thông tin mới nhất ở chế độ nền (Background Fetch)
        refreshUser(storedToken).finally(() => {
          setLoading(false);
        });
      } else {
        setLoading(false);
      }
    }
  }, []);

  // 3. Đăng nhập thành công: Lưu token và thông tin người dùng
  const loginContext = (data) => {
    setToken(data.token);
    setUser(data.user);
    if (typeof window !== 'undefined') {
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
    }
  };

  // 4. Đăng xuất: Xóa sạch dữ liệu cục bộ bảo mật thông tin
  const logoutContext = () => {
    setToken(null);
    setUser(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      token,
      loading,
      loginContext,
      logoutContext,
      refreshUser
    }}>
      {children}
    </AuthContext.Provider>
  );
};
