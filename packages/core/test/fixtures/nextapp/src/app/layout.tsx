import "./globals.css";
import { Header } from "@/components/Header";
import { SaveButton } from "@/components/SaveButton";
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body><Header /><SaveButton />{children}</body></html>;
}
