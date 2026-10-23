import { Route, Routes } from 'react-router-dom';
import { RequireRole } from './auth';
import { Layout } from './components/Layout';
import { AdminOrderDetail, AdminOrders, AdminProducts, AdminShell, Applications, AuditLog, Stores, Users } from './pages/admin/Admin';
import { Account, ForgotPassword, Login, Register, ResetPassword, VerifyEmail } from './pages/AuthPages';
import { Cart, Checkout } from './pages/Cart';
import { OrderDetail, Orders } from './pages/Orders';
import { NewProduct, SellerOrders, SellerProductDetail, SellerProducts, SellerShell } from './pages/seller/Seller';
import { Home, ProductPage } from './pages/Shop';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="product/:id" element={<ProductPage />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Register />} />
        <Route path="forgot-password" element={<ForgotPassword />} />
        <Route path="reset-password" element={<ResetPassword />} />
        <Route path="verify-email" element={<VerifyEmail />} />
        <Route path="account" element={<RequireRole><Account /></RequireRole>} />

        <Route path="cart" element={<RequireRole role="CUSTOMER"><Cart /></RequireRole>} />
        <Route path="checkout" element={<RequireRole role="CUSTOMER"><Checkout /></RequireRole>} />
        <Route path="orders" element={<RequireRole role="CUSTOMER"><Orders /></RequireRole>} />
        <Route path="orders/:id" element={<RequireRole role="CUSTOMER"><OrderDetail /></RequireRole>} />

        <Route path="seller" element={<RequireRole role="SELLER"><SellerShell /></RequireRole>}>
          <Route index element={<SellerProducts />} />
          <Route path="new" element={<NewProduct />} />
          <Route path="products/:id" element={<SellerProductDetail />} />
          <Route path="orders" element={<SellerOrders />} />
        </Route>

        <Route path="admin" element={<RequireRole role="ADMIN"><AdminShell /></RequireRole>}>
          <Route index element={<Applications />} />
          <Route path="stores" element={<Stores />} />
          <Route path="users" element={<Users />} />
          <Route path="products" element={<AdminProducts />} />
          <Route path="orders" element={<AdminOrders />} />
          <Route path="orders/:id" element={<AdminOrderDetail />} />
          <Route path="audit" element={<AuditLog />} />
        </Route>
        <Route path="*" element={<p>Page not found.</p>} />
      </Route>
    </Routes>
  );
}
