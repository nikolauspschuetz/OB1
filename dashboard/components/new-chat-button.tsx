"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function NewChatButton() {
  const router = useRouter();
  const [pending, start] = useTransition();

  function create() {
    start(async () => {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!resp.ok) {
        alert("Failed to create chat");
        return;
      }
      const { id } = (await resp.json()) as { id: number };
      router.push(`/chat/${id}`);
    });
  }

  return (
    <button onClick={create} disabled={pending} className="btn btn-primary">
      {pending ? "Creating…" : "+ New chat"}
    </button>
  );
}
