import {
  IPersonaSessionRegistry,
  type PersonaSessionRegistry
} from '@jupyter-ai/persona-manager';
import { IChatTracker, type IChatPanel } from '@jupyter/chat';
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { LabIcon } from '@jupyterlab/ui-components';
import type { Widget } from '@lumino/widgets';
import {
  IAgentRegistry,
  IAgentTerminals,
  type IAgentStartOptions
} from 'xtralab';

import { ChatSessions } from './chatSessions';
import { PiTerminalDetector } from './piTerminals';

/**
 * A chat persona offered as an agent.
 */
interface IChatAgent {
  /**
   * The agent id, unique among the agents of the launcher.
   */
  id: string;
  /**
   * The chat user id of the persona.
   */
  persona: string;
  /**
   * The plugin that adds the persona to the chats.
   */
  plugin: string;
  /**
   * The name of the persona.
   */
  name: string;
  /**
   * The name of a registered icon.
   */
  icon: string;
  /**
   * Sort position among the agents of the launcher.
   */
  rank: number;
}

const CHAT_AGENTS: IChatAgent[] = [
  {
    id: 'pi-chat',
    persona: 'pi-frontend',
    plugin: '@jupyter-ai/pi-lite:persona',
    name: 'Pi',
    icon: 'xtralab:agent-pi',
    rank: 100
  },
  {
    id: 'jupyternaut',
    persona: 'jupyternaut-frontend',
    plugin: '@jupyter-ai/jupyternaut-lite:plugin',
    name: 'Jupyternaut',
    icon: '@jupyter-ai/jupyternaut-lite:jupyternaut',
    rank: 101
  }
];

const CREATE_CHAT_COMMAND = 'jupyterlab-chat:createAndOpen';

/**
 * How long to wait for a persona to join a new chat before sending anyway.
 */
const PERSONA_TIMEOUT_MS = 10_000;

/**
 * Resolve once `persona` is in the persona list of the chat: the persona then
 * answers the new messages, but not the ones sent before it joined.
 */
function personaJoined(
  registry: PersonaSessionRegistry | null,
  chatId: string,
  persona: string
): Promise<void> {
  if (!registry) {
    return new Promise(resolve => setTimeout(resolve, 1000));
  }
  const manager = registry.get(chatId);
  const joined = (): boolean =>
    manager.personas.some(option => option.id === persona);
  if (joined()) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timeout);
      manager.changed.disconnect(onChanged);
      resolve();
    };
    const onChanged = (): void => {
      if (joined()) {
        done();
      }
    };
    const timeout = setTimeout(done, PERSONA_TIMEOUT_MS);
    manager.changed.connect(onChanged);
  });
}

/**
 * Open a new chat in `cwd` and send the prompt to the persona.
 */
async function startChat(
  app: JupyterFrontEnd,
  registry: PersonaSessionRegistry | null,
  agent: IChatAgent,
  options: IAgentStartOptions
): Promise<Widget | undefined> {
  const widget = (await app.commands.execute(CREATE_CHAT_COMMAND, {
    path: options.cwd ?? ''
  })) as IChatPanel | undefined;
  const model = widget?.model;
  const prompt = options.prompt.trim();
  if (model && prompt) {
    const chatId = await model.ready;
    await personaJoined(registry, chatId, agent.persona);
    // `to_persona` routes the message as the persona menu of the chat does.
    const metadata = { to_persona: agent.persona };
    await model.sendMessage({ body: prompt, metadata });
  }
  return widget;
}

/**
 * Offer the chat personas of Jupyter AI (Jupyternaut, Pi) as agents in the
 * xtralab launcher, omnibox and ask-agent popup, next to the terminal agents.
 * The ask-agent popup also offers the open chats of each persona.
 */
const chatAgentsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'xtralite:chat-agents',
  description:
    'Offer the chat personas as agents, next to the terminal agents of xtralab.',
  autoStart: true,
  requires: [IAgentRegistry],
  optional: [IPersonaSessionRegistry, IChatTracker, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    agentRegistry: IAgentRegistry,
    personaRegistry: PersonaSessionRegistry | null,
    chatTracker: IChatTracker | null,
    translator: ITranslator | null
  ): void => {
    const trans = (translator ?? nullTranslator).load('xtralite');
    for (const agent of CHAT_AGENTS) {
      if (!app.hasPlugin(agent.plugin)) {
        continue;
      }
      agentRegistry.addAgent({
        id: agent.id,
        label: trans.__('%1 chat', agent.name),
        caption: trans.__('Ask %1 in a new chat.', agent.name),
        command: agent.id,
        icon: LabIcon.resolve({ icon: agent.icon }),
        rank: agent.rank,
        requireAvailable: false,
        promptArgs: [],
        start: options => startChat(app, personaRegistry, agent, options),
        startLabel: trans.__('New chat'),
        sessions: chatTracker
          ? new ChatSessions({
              app,
              tracker: chatTracker,
              persona: agent.persona,
              trans
            })
          : undefined
      });
    }
  }
};

/**
 * Tell the xtralab terminals where pi runs: JupyterLite has no server to
 * inspect the processes of the terminals.
 */
const piTerminalsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'xtralite:pi-terminals',
  description: 'Detect pi in the JupyterLite terminals for xtralab.',
  autoStart: true,
  optional: [IAgentTerminals],
  activate: (
    app: JupyterFrontEnd,
    agentTerminals: IAgentTerminals | null
  ): void => {
    agentTerminals?.addDetector(new PiTerminalDetector(app));
  }
};

export default [chatAgentsPlugin, piTerminalsPlugin];
