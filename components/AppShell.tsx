"use client";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import { ChannelProvider } from "./ChannelContext";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/login") {
    return <>{children}</>;
  }

  return (
    <ChannelProvider>
      <Sidebar />
      <main style={{
        flex: 1,
        marginLeft: 220,
        padding: "32px 32px",
        minHeight: "100vh",
        overflowY: "auto",
      }}>
        {children}
      </main>
    </ChannelProvider>
  );
}
