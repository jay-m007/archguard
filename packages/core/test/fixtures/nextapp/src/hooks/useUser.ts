import { useState } from "react";
import { missing } from "@/lib/doesNotExist";
export function useUser() { return useState(missing); }
