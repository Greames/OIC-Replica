"use client";

import { ac, roles } from "@oicr/auth/roles";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [organizationClient({ ac, roles })],
});
