import { Component } from "solid-js";
import { Card, CardContent, Skeleton } from "./ui";

/**
 * loading spinner component
 */
const Loading: Component = () => {
  return (
    <div class="flex min-h-screen items-center justify-center px-6">
      <Card class="w-full max-w-md">
        <CardContent class="space-y-5 py-10">
          <div class="space-y-2 text-center">
            <p class="text-[11px] font-semibold uppercase tracking-[0.32em] text-[var(--muted-foreground)]">
              containr
            </p>
            <h1 class="font-serif text-3xl text-[var(--foreground)]">loading</h1>
          </div>
          <div class="space-y-3">
            <Skeleton class="h-3 w-1/2 mx-auto" />
            <Skeleton class="h-12 w-full" />
            <Skeleton class="h-12 w-full" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Loading;
