import {
  Activity,
  Bot,
  LayoutDashboard,
  Network,
  Play,
  Settings,
  ShieldAlert,
  TerminalSquare,
} from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';

import { Logo } from '@/components/logo';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

const mainNav = [
  { title: 'Dashboard', to: '/', icon: LayoutDashboard },
  { title: 'Runs', to: '/runs', icon: Play },
  { title: 'Agents', to: '/agents', icon: Bot },
];

const systemNav = [
  { title: 'Activity', to: '/activity', icon: Activity },
  { title: 'Terminal', to: '/terminal', icon: TerminalSquare },
  { title: 'Egress', to: '/egress', icon: ShieldAlert },
  { title: 'OmniRoute', to: '/omniroute', icon: Network },
  { title: 'Settings', to: '/settings', icon: Settings },
];

// OmniRoute's sidebar: small uppercase section labels, generous rounded
// items, and the active entry tinted in the primary colour instead of grey.
const groupLabelClass = 'text-[11px] uppercase tracking-wider';
const menuButtonClass =
  'h-10 rounded-lg px-3 data-[active=true]:bg-primary/10 data-[active=true]:text-primary hover:data-[active=true]:bg-primary/15 hover:data-[active=true]:text-primary';

export function AppSidebar() {
  const { pathname } = useLocation();

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/">
                <div className="flex aspect-square size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <Logo className="size-6" />
                </div>
                <span className="font-mono text-lg font-bold leading-none">
                  e -
                </span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className={groupLabelClass}>
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNav.map(item => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === item.to}
                    tooltip={item.title}
                    className={menuButtonClass}
                  >
                    <NavLink to={item.to}>
                      <item.icon />
                      <span>{item.title}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel className={groupLabelClass}>
            System
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {systemNav.map(item => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === item.to}
                    tooltip={item.title}
                    className={menuButtonClass}
                  >
                    <NavLink to={item.to}>
                      <item.icon />
                      <span>{item.title}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent"
            >
              <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <span className="font-mono text-sm font-bold">e</span>
              </div>
              <div className="flex-1 leading-tight">
                <p className="truncate text-sm font-medium">local user</p>
                <p className="truncate text-xs text-sidebar-foreground/60">
                  orchestrator
                </p>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
