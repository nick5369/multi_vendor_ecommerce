import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, ORD, type Cart } from '../api';
import { useAuth } from '../auth';

export function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const isCustomer = !!user?.roles.includes('CUSTOMER');
  const cart = useQuery({ queryKey: ['cart'], queryFn: () => api<Cart>(`${ORD}/cart`), enabled: isCustomer });
  const count = cart.data?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;

  return (
    <>
      <header className="top">
        <Link to="/" className="brand">Marketplace <small>test mode</small></Link>
        <nav>
          <NavLink to="/">Shop</NavLink>
          {isCustomer && <NavLink to="/cart">Cart{count > 0 && <span className="pill">{count}</span>}</NavLink>}
          {isCustomer && <NavLink to="/orders">My orders</NavLink>}
          {user?.roles.includes('SELLER') && <NavLink to="/seller">Seller</NavLink>}
          {user?.roles.includes('ADMIN') && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="who">
          {user ? (
            <>
              <Link to="/account">{user.name}</Link>
              <button className="btn" onClick={async () => { await logout(); nav('/'); }}>Log out</button>
            </>
          ) : (
            <>
              <Link to="/login">Log in</Link>
              <Link to="/register" className="btn primary">Sign up</Link>
            </>
          )}
        </div>
      </header>
      <main><Outlet /></main>
      <footer className="muted">Local development build · Razorpay TEST mode · no real money moves</footer>
    </>
  );
}
