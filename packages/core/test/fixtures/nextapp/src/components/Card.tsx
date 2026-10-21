import { GET } from "@/app/api/users/route";     // VIOLATION: components -> api
import type { User } from "@/lib/types";
export function Card({ title }: { title: string; user?: User }) { void GET; return <div>{title}</div>; }
