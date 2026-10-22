import type { Metadata } from "next";
import { headers } from "next/headers";
import ChatDock from "./chat/ChatDock.tsx";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") || "localhost";
  const protocol = host.includes("localhost") ? "http" : "https";
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "Study Hub — Your private exam workspace",
    description: "Turn any local revision folder into a private reading and flashcard workspace.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title: "Study Hub", description: "Your private exam workspace", images: [{ url: image, width: 1672, height: 941 }] },
    twitter: { card: "summary_large_image", title: "Study Hub", description: "Your private exam workspace", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}<ChatDock /></body></html>;
}
