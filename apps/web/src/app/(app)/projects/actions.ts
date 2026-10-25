"use server";

import { ConflictError, createProject, ForbiddenError } from "@oicr/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";

export interface FormState {
  error?: string;
}

export async function createProjectAction(_prev: FormState, form: FormData): Promise<FormState> {
  const viewer = await requireViewer();
  let id: string;
  try {
    const project = await createProject(db, viewer, {
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? ""),
    });
    id = project.id;
  } catch (e) {
    if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? "Check the form." };
    if (e instanceof ConflictError || e instanceof ForbiddenError) return { error: e.message };
    throw e;
  }
  revalidatePath("/projects");
  redirect(`/projects/${id}`);
}
