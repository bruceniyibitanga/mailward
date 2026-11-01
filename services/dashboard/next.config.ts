import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a small self-contained server in .next/standalone,
  // which keeps the Docker image small.
  output: "standalone",
};

export default nextConfig;
