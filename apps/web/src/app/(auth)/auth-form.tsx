"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldError, Input, Label } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function AuthForm({ mode, google }: { mode: "sign-in" | "sign-up"; google: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const signUp = mode === "sign-up";

  // onSubmit, not a form action: a failed attempt must keep what was typed.
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    const res = signUp
      ? await authClient.signUp.email({ email, password, name: String(form.get("name")) })
      : await authClient.signIn.email({ email, password });
    setPending(false);
    if (res.error) {
      setError(res.error.message ?? "Something went wrong. Try again.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold">{signUp ? "Create your account" : "Sign in"}</h1>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        {signUp && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" autoComplete="name" required />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={signUp ? "new-password" : "current-password"}
            minLength={signUp ? 10 : undefined}
            required
          />
          {signUp && <p className="text-xs text-fg-muted">At least 10 characters.</p>}
        </div>
        <FieldError>{error}</FieldError>
        <Button type="submit" disabled={pending}>
          {pending ? "One moment…" : signUp ? "Create account" : "Sign in"}
        </Button>
      </form>
      {google && (
        <Button
          variant="secondary"
          className="mt-3 w-full"
          onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/" })}
        >
          Continue with Google
        </Button>
      )}
      <p className="mt-6 text-center text-sm text-fg-muted">
        {signUp ? "Already have an account? " : "New here? "}
        <Link href={signUp ? "/sign-in" : "/sign-up"} className="font-medium text-accent hover:underline">
          {signUp ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </Card>
  );
}
