import { googleEnabled } from "@/lib/auth";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Create account" };

export default function SignUpPage() {
  return <AuthForm mode="sign-up" google={googleEnabled} />;
}
