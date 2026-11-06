import { pictureProps, type ImageAttributes } from "@dustinedwards/site-runtime/image";

/**
 * A post's cover from coverPicture (app/lib/blog/markdown.server.ts), the
 * page's largest picture, written by site-runtime's pictureProps like every
 * other picture on the network: AVIF and WebP sizes where it has them, and the
 * library's stored placeholder and color while it loads. It is the page's
 * priority image (eager, fetchpriority high). `contents` leaves the box to the
 * img, as before the picture was added.
 */
export function CoverPicture({ cover, className }: { cover: { alt: string; picture: ImageAttributes }; className: string }) {
  const { sources, img } = pictureProps(cover.picture, { alt: cover.alt, priority: true, className });
  return (
    <picture className="contents">
      {sources.map((source) => (
        <source key={`${source.type}${source.media ?? ""}`} {...source} />
      ))}
      <img {...img} />
    </picture>
  );
}
