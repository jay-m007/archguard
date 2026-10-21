import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "path";
export const db = { users: () => [new PrismaClient(), fs, path] };
