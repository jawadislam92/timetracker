import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Pencil, Send, Sparkles, X } from 'lucide-react';

/**
 * Floating AI chat bubble, available on every page for anyone who can view
 * reports. Config (suggested questions + enabled flag) loads lazily on first
 * open so closed widgets cost nothing.
 */
const capMessages = (msgs) => msgs.slice(-100); // bound DOM/memory on long chats

export default function AiChatWidget() {
    const [open, setOpen] = useState(false);
    const [config, setConfig] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const bottomRef = useRef(null);

    useEffect(() => {
        if (open && !config) {
            axios.get(route('ai.assistant.config'))
                .then((res) => setConfig(res.data))
                .catch(() => setConfig({ enabled: false, questions: [], canManageQuestions: false }));
        }
    }, [open]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, loading, open]);

    const send = async (text) => {
        const content = (text ?? input).trim();
        if (!content || loading) return;

        const next = [...messages, { role: 'user', content }];
        setMessages(capMessages(next));
        setInput('');
        setLoading(true);

        try {
            const res = await axios.post(route('ai.assistant.ask'), { messages: next.slice(-10) });
            setMessages(capMessages([...next, { role: 'assistant', content: res.data.reply }]));
        } catch (err) {
            const msg = err.response?.data?.message || 'Something went wrong — try again.';
            setMessages(capMessages([...next, { role: 'assistant', content: `⚠️ ${msg}` }]));
        } finally {
            setLoading(false);
        }
    };

    const startEditing = () => {
        setDraft((config?.questions || []).join('\n'));
        setEditing(true);
    };

    const saveQuestions = async () => {
        setSaving(true);
        try {
            const questions = draft.split('\n').map((q) => q.trim()).filter(Boolean);
            const res = await axios.post(route('ai.assistant.questions'), { questions });
            setConfig({ ...config, questions: res.data.questions });
            setEditing(false);
        } catch {
            // keep the editor open so nothing typed is lost
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            {!open && (
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    title="Ask the AI Assistant"
                    className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full sm:bottom-5 sm:right-5 sm:h-14 sm:w-14 bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-xl shadow-orange-500/40 transition hover:scale-105 hover:from-orange-600 hover:to-amber-600"
                >
                    <Sparkles className="h-6 w-6" />
                </button>
            )}

            {open && (
                <div className="fixed bottom-5 right-5 z-50 flex h-[540px] w-[370px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50">
                    <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-amber-500">
                                <Sparkles className="h-4 w-4 text-white" />
                            </span>
                            <div className="leading-tight">
                                <p className="text-sm font-semibold text-white">AI Assistant</p>
                                <p className="text-[10px] text-slate-400">Last 14 days of team data</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-1">
                            {config?.canManageQuestions && !editing && (
                                <button type="button" onClick={startEditing} title="Edit common questions" className="rounded p-1.5 text-slate-400 hover:bg-white/10 hover:text-white">
                                    <Pencil className="h-4 w-4" />
                                </button>
                            )}
                            <button type="button" onClick={() => setOpen(false)} className="rounded p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Close">
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    </div>

                    {editing ? (
                        <div className="flex flex-1 flex-col gap-2 p-4">
                            <p className="text-xs font-semibold text-white">Common questions (one per line)</p>
                            <textarea
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                className="flex-1 resize-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs leading-5 text-slate-200 focus:border-orange-500 focus:ring-orange-500"
                            />
                            <div className="flex justify-end gap-2">
                                <button type="button" onClick={() => setEditing(false)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
                                <button type="button" onClick={saveQuestions} disabled={saving} className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                                    {saving ? 'Saving…' : 'Save questions'}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="flex-1 space-y-3 overflow-y-auto p-4">
                                {messages.length === 0 && (
                                    <div className="space-y-2">
                                        <p className="text-xs text-slate-400">Ask about hours, people, clients, shifts — or pick one:</p>
                                        {(config?.questions || []).map((q) => (
                                            <button
                                                key={q}
                                                type="button"
                                                onClick={() => send(q)}
                                                disabled={!config?.enabled}
                                                className="block w-full rounded-lg border border-slate-700 px-3 py-2 text-left text-xs text-slate-300 transition hover:border-orange-500/50 hover:bg-orange-500/10 hover:text-orange-300"
                                            >
                                                {q}
                                            </button>
                                        ))}
                                        {config && !config.enabled && (
                                            <p className="text-xs text-amber-300">AI is not configured — add the Anthropic key under Developer → AI.</p>
                                        )}
                                    </div>
                                )}

                                {messages.map((m, i) => (
                                    <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                                        <div className={[
                                            'max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-xs leading-5',
                                            m.role === 'user'
                                                ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white'
                                                : 'border border-slate-800 bg-slate-950/60 text-slate-200',
                                        ].join(' ')}>
                                            {m.content}
                                        </div>
                                    </div>
                                ))}

                                {loading && (
                                    <div className="flex justify-start">
                                        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 px-3 py-2.5">
                                            <span className="inline-flex gap-1">
                                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-orange-400" style={{ animationDelay: '0ms' }} />
                                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-orange-400" style={{ animationDelay: '150ms' }} />
                                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-orange-400" style={{ animationDelay: '300ms' }} />
                                            </span>
                                        </div>
                                    </div>
                                )}
                                <div ref={bottomRef} />
                            </div>

                            <form
                                onSubmit={(e) => { e.preventDefault(); send(); }}
                                className="flex items-end gap-2 border-t border-slate-800 bg-slate-950 p-3"
                            >
                                <textarea
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                                    }}
                                    rows={1}
                                    placeholder={config?.enabled ? 'Ask a question…' : 'AI not configured'}
                                    disabled={!config?.enabled}
                                    className="flex-1 resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:border-orange-500 focus:ring-orange-500 disabled:opacity-50"
                                />
                                <button
                                    type="submit"
                                    disabled={loading || !input.trim() || !config?.enabled}
                                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 text-white disabled:opacity-50"
                                    aria-label="Send"
                                >
                                    <Send className="h-4 w-4" />
                                </button>
                            </form>
                        </>
                    )}
                </div>
            )}
        </>
    );
}
