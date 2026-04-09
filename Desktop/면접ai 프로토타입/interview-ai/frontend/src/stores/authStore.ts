/**
 * 인증 상태 전역 스토어 (Zustand)
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { User } from "@/types";
import { authApi } from "@/lib/api";

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;

  login: (email: string, password: string) => Promise<void>;
  register: (data: {
    email: string;
    password: string;
    name: string;
    target_job_category?: string;
  }) => Promise<void>;
  logout: () => void;
  updateUser: (data: { name?: string; target_job_category?: string; target_job_keywords?: string[] }) => Promise<void>;
  loadUser: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,

      login: async (email, password) => {
        const data = await authApi.login(email, password);
        localStorage.setItem("access_token", data.access_token);
        localStorage.setItem("refresh_token", data.refresh_token);
        set({
          user: data.user,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          isAuthenticated: true,
        });
      },

      register: async (registerData) => {
        const data = await authApi.register(registerData);
        localStorage.setItem("access_token", data.access_token);
        localStorage.setItem("refresh_token", data.refresh_token);
        set({
          user: data.user,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          isAuthenticated: true,
        });
      },

      logout: () => {
        localStorage.removeItem("access_token");
        localStorage.removeItem("refresh_token");
        set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false });
      },

      updateUser: async (data) => {
        const updated = await authApi.updateMe(data);
        set({ user: updated });
      },

      loadUser: async () => {
        try {
          const user = await authApi.getMe();
          set({ user, isAuthenticated: true });
        } catch {
          get().logout();
        }
      },
    }),
    {
      name: "auth-storage",
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
