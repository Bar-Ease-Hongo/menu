import { NextResponse } from 'next/server';

import type { RecommendRequestBody, RecommendResponseBody } from '@bar-ease/core';

import { fetchMenu } from '../../../lib/menu';

function computeScore(textTokens: string[], itemTokens: string[], filters?: RecommendRequestBody['filters']) {
  let score = 0;
  for (const token of textTokens) {
    if (itemTokens.includes(token)) {
      score += 1;
    }
  }

  if (filters?.category?.length) {
    score += filters.category.includes(itemTokens.find((token) => token.startsWith('category:'))?.split(':')[1] ?? '') ? 0.5 : 0;
  }

  if (filters?.maker?.length) {
    score += filters.maker.includes(itemTokens.find((token) => token.startsWith('maker:'))?.split(':')[1] ?? '') ? 0.5 : 0;
  }

  if (filters?.abv) {
    const abvToken = itemTokens.find((token) => token.startsWith('abv:'));
    if (abvToken && abvToken.split(':')[1] === filters.abv) {
      score += 0.3;
    }
  }

  if (filters?.priceRange) {
    const priceToken = itemTokens.find((token) => token.startsWith('price:'));
    if (priceToken && priceToken.split(':')[1] === filters.priceRange) {
      score += 0.3;
    }
  }

  return score;
}

export async function POST(request: Request) {
  const body = (await request.json()) as RecommendRequestBody;

  if (!body.text || body.text.trim().length === 0) {
    return NextResponse.json({ message: 'text is required' }, { status: 400 });
  }

  const { items } = await fetchMenu();
  const normalized = body.text.toLowerCase().split(/[\s、。,.]+/).filter(Boolean);

  const candidates = items
    .filter((item) => item.status === 'Published' && item.aiStatus === 'Approved')
    .map((item) => {
      const tokens = [
        item.name.toLowerCase(),
        ...item.tags.map((tag) => tag.toLowerCase()),
        ...item.description.toLowerCase().split(/[\s、。,.]+/),
        `maker:${item.maker.toLowerCase()}`,
        `category:${item.category.toLowerCase()}`
      ];

      if (item.abvClass) {
        tokens.push(`abv:${item.abvClass}`);
      }
      if (item.priceClass) {
        tokens.push(`price:${item.priceClass}`);
      }

      return {
        item,
        score: computeScore(normalized, tokens, body.filters)
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, body.limit ?? 5)
    .map((candidate) => ({
      id: candidate.item.id,
      score: candidate.score,
      name: candidate.item.name,
      maker: candidate.item.maker,
      imageUrl: candidate.item.imageUrl,
      reason: candidate.item.description
    }));

  const response: RecommendResponseBody = { items: candidates };
  return NextResponse.json(response, { status: 200 });
}
