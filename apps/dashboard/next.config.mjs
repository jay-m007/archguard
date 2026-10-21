/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the dashboard is plain HTML/JS/CSS that can be opened from
  // `archguard dashboard`, any static host, or GitHub Pages. No server needed.
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
