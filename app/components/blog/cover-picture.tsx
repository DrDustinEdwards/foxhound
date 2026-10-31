import type { ImageAttributes } from "@dustinedwards/site-runtime/image";

/**
 * A post's cover from coverPicture (app/lib/blog/markdown.server.ts), the
 * page's largest picture: AVIF and WebP sizes where it has them. `contents`
 * leaves the box to the img, as before the picture was added.
 */
export function CoverPicture({ cover, className }: { cover: { alt: string; picture: Partial<ImageAttributes> }; className: string }) {
  const { src, srcset, sizes, sources = [], width, height } = cover.picture;
  return (
    <picture className="contents">
      {sources.map((source) => (
        <source key={source.type} type={source.type} srcSet={source.srcset} sizes={sizes} />
      ))}
      <img src={src} srcSet={srcset} sizes={sizes} width={width} height={height} alt={cover.alt} className={className} fetchPriority="high" decoding="async" />
    </picture>
  );
}
