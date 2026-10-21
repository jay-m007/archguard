import { GET } from "../api/users/route";       // VIOLATION: routes -> api
import { useUser } from "@/hooks/useUser";
export default async function Dashboard() { useUser(); await GET(); return null; }
