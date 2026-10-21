import { save } from "@/app/dashboard/actions/save";   // OK: server action is a service
export function SaveButton() { return <form action={save}><button /></form>; }
