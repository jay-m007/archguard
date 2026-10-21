"use server";
import { db } from "@/lib/db";
export async function save() { return db.users(); }
