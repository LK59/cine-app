export function SkeletonCard({
  width = "w-28",
  aspectRatio = "aspect-[2/3]",
  rounded = "rounded-xl",
  lines = 2,
}: {
  width?: string;
  aspectRatio?: string;
  rounded?: string;
  lines?: number;
}) {
  return (
    <div className={`${width} shrink-0`}>
      <div className={`${aspectRatio} ${rounded} bg-slate-800 animate-pulse`} />
      <div className="mt-2 h-2.5 w-3/4 rounded-md bg-slate-800 animate-pulse" />
      {lines > 1 && <div className="mt-1.5 h-2 w-1/2 rounded-md bg-slate-700/60 animate-pulse" />}
    </div>
  );
}

export function CarouselSkeleton({
  count = 6,
  ...props
}: {
  count?: number;
  width?: string;
  aspectRatio?: string;
  rounded?: string;
  lines?: number;
}) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} {...props} />
      ))}
    </>
  );
}
