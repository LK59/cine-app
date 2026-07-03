import { Sidebar } from "@/components/Sidebar";
import { MobileNav } from "@/components/MobileNav";
import { GlobalSearch } from "@/components/GlobalSearch";
import { SSENotifier } from "@/components/SSENotifier";
import { KeyboardShortcutsModal } from "@/components/KeyboardShortcutsModal";
import { ScrollRestorer } from "@/components/ScrollRestorer";
import { PageTransition } from "@/components/PageTransition";
import { MainScroll } from "@/components/MainScroll";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden" style={{ height: "100dvh" }}>
      <Sidebar />
      <MainScroll className="scrollbar-thin flex-1 overflow-y-auto px-4 pb-24 pt-[calc(1rem+env(safe-area-inset-top))] sm:px-6 sm:pb-6 sm:pt-[calc(1.5rem+env(safe-area-inset-top))] md:px-8">
        <ScrollRestorer />
        <div className="w-full">
          <PageTransition>{children}</PageTransition>
        </div>
      </MainScroll>
      <MobileNav />
      <GlobalSearch />
      <SSENotifier />
      <KeyboardShortcutsModal />
    </div>
  );
}
