// A relay may ignore stream:true. Adapt a completed Responses object without
// dropping opaque output, phases, tool call IDs or usage metadata.
export function responsesJsonToSse(value) {
  const events = [];
  const emit = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: events.length, ...data })}\n\n`);
  emit("response.created", { response: { ...value, status: "in_progress", output: [], usage: null } });
  for (const [output_index, item] of value.output.entries()) {
    const ref = { output_index, item_id: item.id };
    const initial = { ...item, status: "in_progress" };
    if (item.type === "message") initial.content = [];
    if (item.type === "function_call") initial.arguments = "";
    if (item.type === "custom_tool_call") initial.input = "";
    emit("response.output_item.added", { output_index, item: initial });
    if (item.type === "message") {
      for (const [content_index, part] of (item.content || []).entries()) {
        emit("response.content_part.added", { ...ref, content_index, part: { ...part, ...(part.type === "output_text" ? { text: "" } : {}) } });
        if (part.type === "output_text") {
          emit("response.output_text.delta", { ...ref, content_index, delta: part.text });
          emit("response.output_text.done", { ...ref, content_index, text: part.text });
        }
        emit("response.content_part.done", { ...ref, content_index, part });
      }
    } else if (item.type === "function_call") {
      emit("response.function_call_arguments.delta", { ...ref, delta: item.arguments });
      emit("response.function_call_arguments.done", { ...ref, arguments: item.arguments });
    } else if (item.type === "custom_tool_call") {
      emit("response.custom_tool_call_input.delta", { ...ref, delta: item.input });
      emit("response.custom_tool_call_input.done", { ...ref, input: item.input });
    }
    emit("response.output_item.done", { output_index, item });
  }
  emit("response.completed", { response: value });
  return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}
