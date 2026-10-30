"use client";

import { createContext, useContext } from "react";
import type { CrmRole } from "@/lib/types";

export const RolePreviewContext = createContext<CrmRole>("admin");

export function useRolePreview() {
  return useContext(RolePreviewContext);
}