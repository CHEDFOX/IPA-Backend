import { parseJson } from './util.js';

const SIZE_ORDER = ['sm', 'md', 'lg'];

export function createSerializer(publicUrl) {
  const url = (file) => `${publicUrl}/media/${file}`;

  function imageSet(variants) {
    const sizes = SIZE_ORDER.filter((k) => variants[k]).map((k) => ({
      url: url(variants[k].file),
      width: variants[k].width,
      height: variants[k].height,
    }));
    if (!sizes.length) return null;
    return { sizes, og: variants.og ? url(variants.og.file) : sizes.at(-1).url };
  }

  function media(row) {
    const variants = parseJson(row.variants, {});
    const base = { id: row.id, kind: row.kind, alt: row.alt };
    if (row.kind === 'image') {
      return { ...base, width: row.width, height: row.height, ...imageSet(variants) };
    }
    if (row.kind === 'video') {
      return {
        ...base,
        url: url(row.file),
        mime: row.mime,
        width: row.width,
        height: row.height,
        duration: row.duration,
        poster: imageSet(variants),
      };
    }
    return { ...base, url: url(row.file), mime: row.mime, bytes: row.bytes, name: row.original_name };
  }

  // The first photo, or the poster frame of the first video when there are no photos.
  function coverOf(gallery) {
    const image = gallery.find((m) => m.kind === 'image');
    if (image) return { alt: image.alt, width: image.width, height: image.height, sizes: image.sizes, og: image.og };
    const video = gallery.find((m) => m.kind === 'video' && m.poster);
    if (video) return { alt: video.alt, width: video.width, height: video.height, ...video.poster };
    return null;
  }

  function common(row) {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      titleHi: row.title_hi,
      type: row.type,
      status: row.status,
      visibility: row.visibility,
      featured: Boolean(row.featured),
      price: row.price,
      priceNote: row.price_note,
      location: row.location,
      locationHi: row.location_hi,
      area: row.area,
      areaUnit: row.area_unit,
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      summary: row.summary,
      summaryHi: row.summary_hi,
      updatedAt: row.updated_at,
    };
  }

  function card(row, galleryRows = []) {
    const gallery = galleryRows.map(media);
    return {
      ...common(row),
      cover: coverOf(gallery),
      photoCount: gallery.filter((m) => m.kind === 'image').length,
      videoCount: gallery.filter((m) => m.kind === 'video').length,
    };
  }

  function property(row, mediaRows = []) {
    const gallery = mediaRows.filter((m) => m.role === 'gallery').map(media);
    const plan = mediaRows.find((m) => m.role === 'plan');
    const brochure = mediaRows.find((m) => m.role === 'brochure');
    return {
      ...common(row),
      address: row.address,
      addressHi: row.address_hi,
      latitude: row.latitude,
      longitude: row.longitude,
      description: row.description,
      descriptionHi: row.description_hi,
      details: parseJson(row.details, []),
      nearby: parseJson(row.nearby, []),
      cover: coverOf(gallery),
      gallery,
      plan: plan ? media(plan) : null,
      brochure: brochure ? media(brochure) : null,
      createdAt: row.created_at,
    };
  }

  function adminProperty(row, mediaRows = []) {
    return { ...property(row, mediaRows), shareToken: row.share_token, sortOrder: row.sort_order };
  }

  return { media, card, property, adminProperty };
}
