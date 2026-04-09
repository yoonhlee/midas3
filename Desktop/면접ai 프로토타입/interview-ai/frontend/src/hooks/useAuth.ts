"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/authStore";

export function useAuth(requireAuth = true) {
  const { isAuthenticated, user, loadUser } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = localStorage.getItem("access_token");
    if (token && !user) {
      loadUser();
    } else if (!token && requireAuth) {
      router.push("/auth/login");
    }
  }, [isAuthenticated, user, loadUser, router, requireAuth]);

  return { isAuthenticated, user };
}
