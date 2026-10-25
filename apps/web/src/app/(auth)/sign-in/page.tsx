import { googleEnabled } from "@/lib/auth";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Sign in" };

export default function SignInPage() {
  return <AuthForm mode="sign-in" google={googleEnabled} />;
}
