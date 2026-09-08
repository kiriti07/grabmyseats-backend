import type { RatingSummary } from "@grabmyseats/shared";
import { prisma } from "./prisma";

const RECENT_COMMENTS_LIMIT = 5;

// Shared by GET /api/users/:id/rating-summary (the public, identified
// endpoint) and everywhere a rating summary is embedded without exposing
// a user id - GET /api/listings/:id (sellerRatingSummary) and GET
// /api/transactions/:id/contact (TransactionContact.ratingSummary) - so
// the averaging/count/recent-comments logic exists exactly once.
export async function getRatingSummary(userId: string): Promise<RatingSummary> {
  const [aggregate, recentWithComments] = await Promise.all([
    prisma.rating.aggregate({
      where: { ratedUserId: userId },
      _avg: { stars: true },
      _count: { _all: true },
    }),
    prisma.rating.findMany({
      where: { ratedUserId: userId, comment: { not: null } },
      orderBy: { createdAt: "desc" },
      take: RECENT_COMMENTS_LIMIT,
      select: { stars: true, comment: true, createdAt: true },
    }),
  ]);

  const totalRatings = aggregate._count._all;

  return {
    // null (not 0) with zero ratings - see the comment on RatingSummary in
    // shared/src/rating.ts for why that's what lets the frontend show "No
    // ratings yet" instead of a misleading "0 ★".
    averageStars: totalRatings > 0 ? aggregate._avg.stars : null,
    totalRatings,
    recentComments: recentWithComments.map((r) => ({
      stars: r.stars,
      // Non-null by construction of the `comment: { not: null }` filter
      // above.
      comment: r.comment!,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
