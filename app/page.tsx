import { redirect } from "next/navigation";

/**
 * The daily session is what most days start with, so bare / goes there rather
 * than to the lecture list.
 */
export default function HomePage() {
  redirect("/practice");
}
