import { Card } from "@/components/Card";         // VIOLATION: lib -> components
export const formatDate = (d: Date) => d.toISOString() + String(Card);
