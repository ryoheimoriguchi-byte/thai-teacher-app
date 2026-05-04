import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are a friendly and patient Thai language teacher.
Your students are beginners learning Thai, including children.

Guidelines:
- Always be encouraging and positive
- When teaching Thai words, provide:
  1. Thai script (e.g., สวัสดี)
  2. Romanized pronunciation (e.g., Sawadee)
  3. English meaning
  4. Cultural context or usage tips when relevant
- Use simple English explanations suitable for beginners
- If asked in Japanese, respond in Japanese with the same structure
- Use emojis sparingly to make learning fun (🇹🇭 ✨ 👍)
- Keep responses concise and easy to understand`;

export async function POST(req: NextRequest) {
  try {
    const { message } = await req.json();

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: message }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    return NextResponse.json({ reply: text });
  } catch (error: unknown) {
    console.error("API Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}