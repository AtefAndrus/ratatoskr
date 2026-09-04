import type { Database } from "bun:sqlite";

/** 投稿 URL のホストとして使えるドメイン。x.com 以外は埋め込みを整形する外部サービス。 */
export const LINK_DOMAINS = ["x.com", "fixupx.com", "fixvx.com"] as const;
export type LinkDomain = (typeof LINK_DOMAINS)[number];

export interface GuildSettings {
  guildId: string;
  linkDomain: LinkDomain;
}

export function isLinkDomain(value: string): value is LinkDomain {
  return (LINK_DOMAINS as readonly string[]).includes(value);
}

export class GuildSettingsRepository {
  constructor(private readonly db: Database) {}

  get(guildId: string): GuildSettings {
    const row = this.db
      .query(
        "SELECT guild_id AS guildId, link_domain AS linkDomain FROM guild_settings WHERE guild_id = $guildId",
      )
      .get({ guildId }) as { guildId: string; linkDomain: string } | null;
    if (row === null || !isLinkDomain(row.linkDomain)) return { guildId, linkDomain: "x.com" };
    return { guildId, linkDomain: row.linkDomain };
  }

  setLinkDomain(guildId: string, linkDomain: LinkDomain): void {
    this.db
      .query(
        `INSERT INTO guild_settings (guild_id, link_domain) VALUES ($guildId, $linkDomain)
         ON CONFLICT (guild_id) DO UPDATE SET
           link_domain = excluded.link_domain,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run({ guildId, linkDomain });
  }
}
