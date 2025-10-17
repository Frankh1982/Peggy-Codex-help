import OpenAI from 'openai';

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
};

export type ModelTool = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown) => Promise<unknown> | unknown;
};

export type ExecutedTool = {
  id: string;
  name: string;
  args: unknown;
  result: unknown;
};

export type ModelStepResult = {
  stream: AsyncIterable<string>;
  executedTools: ExecutedTool[];
  preliminaryText?: string;
};

let client: OpenAI | null = null;

export function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set.');
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

function toResponseInput(messages: ModelMessage[]) {
  return messages.map((msg) => {
    const base: Record<string, unknown> = {
      role: msg.role,
      content: [{ type: 'text', text: msg.content }]
    };
    if (msg.role === 'tool' && msg.tool_call_id) {
      base.tool_call_id = msg.tool_call_id;
    }
    if (msg.name) {
      base.name = msg.name;
    }
    return base;
  });
}

export async function modelStep(
  messages: ModelMessage[],
  tools: ModelTool[] = []
): Promise<ModelStepResult> {
  const openai = getClient();
  const model = process.env.MODEL || 'gpt-4o-mini';

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const toolDefs = tools.length
    ? tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
    : undefined;

  const first = await openai.responses.create({
    model,
    input: toResponseInput(messages),
    tools: toolDefs as any,
    stream: false
  });

  const executedTools: ExecutedTool[] = [];
  const conversation: ModelMessage[] = [...messages];
  const firstText = (first.output_text || '').trim();
  if (firstText) {
    conversation.push({ role: 'assistant', content: firstText });
  }

  const toolCalls = first.required_action?.submit_tool_outputs?.tool_calls || [];

  if (toolCalls.length) {
    for (const call of toolCalls) {
      const target = toolMap.get(call.name);
      if (!target) {
        throw new Error(`Requested unknown tool: ${call.name}`);
      }
      let parsedArgs: unknown = {};
      try {
        parsedArgs = call.arguments ? JSON.parse(call.arguments) : {};
      } catch (err) {
        throw new Error(`Failed to parse tool arguments for ${call.name}`);
      }
      const result = await target.execute(parsedArgs);
      const serialized =
        typeof result === 'string' ? result : JSON.stringify(result);
      executedTools.push({ id: call.id, name: call.name, args: parsedArgs, result });
      conversation.push({
        role: 'tool',
        content: serialized,
        name: call.name,
        tool_call_id: call.id
      });
    }

    const followStream = (await openai.responses.stream({
      model,
      input: toResponseInput(conversation)
    } as any)) as AsyncIterable<any>;

    async function* iterator() {
      for await (const event of followStream) {
        if (event.type === 'response.output_text.delta') {
          yield event.delta as string;
        }
      }
    }

    return { stream: iterator(), executedTools, preliminaryText: firstText };
  }

  async function* singleShot() {
    if (firstText) {
      yield firstText;
    }
  }

  return { stream: singleShot(), executedTools, preliminaryText: firstText };
}
