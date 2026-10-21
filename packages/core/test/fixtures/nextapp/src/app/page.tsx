import { Card } from "@/components/Card";
import { formatDate } from "@/lib/format";
export default function Home() { return <Card title={formatDate(new Date())} />; }
