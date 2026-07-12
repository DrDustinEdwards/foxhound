import { Outlet } from "react-router";

import { Header } from "~/components/header";

export default function MarketingLayout() {
  return (
    <div>
      <Header />
      <Outlet />
    </div>
  );
}
