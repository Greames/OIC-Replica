import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["postgres", "pg-boss", "undici"],
};

export default config;
