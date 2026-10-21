import type { Metadata, Viewport } from "next";
import "@xyflow/react/dist/base.css";
import "./globals.css";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "ArchGuard",
  description: "Explore a codebase's dependency graph, architecture violations and drift over time.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// Applies the saved theme before first paint, so there is no light/dark flash.
const themeScript = `try{var t=localStorage.getItem("archguard-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
