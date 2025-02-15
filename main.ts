
import { Console } from 'console';
import { Editor, Plugin, MarkdownRenderer, getAllTags, TFile, TagCache, CachedMetadata } from 'obsidian';
import { SummarySettingTab } from "./settings";
import { SummaryModal } from "./summarytags";

interface SummarySettings {
	includecallout: boolean;
	includelink: boolean;
	removetags: boolean;
	listparagraph: boolean;
	includechildren: boolean;
}
const DEFAULT_SETTINGS: Partial<SummarySettings> = {
	includecallout: true,
	includelink: true,
	removetags: false,
	listparagraph: true,
	includechildren: true,
};
type FileInfo = [TFile, string, CachedMetadata];
export default class SummaryPlugin extends Plugin {
	settings: SummarySettings;
	regex = /\^([^^]+?)\n/;

	async onload() {
		// Prepare Settings
		await this.loadSettings();
		this.addSettingTab(new SummarySettingTab(this.app, this));

		// Create command to create a summary
		this.addCommand({
			id: "summary-modal",
			name: "Add Summary",
			editorCallback: (editor: Editor) => {
				new SummaryModal(this.app, (include, exclude) => {
					// Format code block to add summary
					let summary = "```add-summary\n";

					// Add the tags label with the tag selected by the user
					summary += "tags: " + include + "\n";

					// Add the exclude label with the tags to exclude
					if (exclude != "None") {
						summary += "exclude: " + exclude + "\n";
					}
					summary += "```\n";
					editor.replaceRange(summary, editor.getCursor());
				}).open();
			},
		});

		// Post processor
		this.registerMarkdownCodeBlockProcessor("add-summary", async (source, el, ctx) => {
			// Initialize tag list
			let tags: string[] = Array();
			let include: string[] = Array();
			let exclude: string[] = Array();

			// Process rows inside codeblock
			const rows = source.split("\n").filter((row) => row.length > 0);
			rows.forEach((line) => {
				// Check if the line specifies the tags (OR)
				if (line.match(/^\s*tags:[\p{L}0-9_\-/# ]+$/gu)) {
					const content = line.replace(/^\s*tags:/, "").trim();

					// Get the list of valid tags and assign them to the tags variable
					let list = content.split(/\s+/).map((tag) => tag.trim());
					list = list.filter((tag) => {
						if (tag.match(/^#[\p{L}]+[^#]*$/u)) {
							return true;
						} else {
							return false;
						}
					});
					tags = list;
				}
				// Check if the line specifies the tags to include (AND)
				if (line.match(/^\s*include:[\p{L}0-9_\-/# ]+$/gu)) {
					const content = line.replace(/^\s*include:/, "").trim();

					// Get the list of valid tags and assign them to the include variable
					let list = content.split(/\s+/).map((tag) => tag.trim());
					list = list.filter((tag) => {
						if (tag.match(/^#[\p{L}]+[^#]*$/u)) {
							return true;
						} else {
							return false;
						}
					});
					include = list;
				}
				// Check if the line specifies the tags to exclude (NOT)
				if (line.match(/^\s*exclude:[\p{L}0-9_\-/# ]+$/gu)) {
					const content = line.replace(/^\s*exclude:/, "").trim();

					// Get the list of valid tags and assign them to the exclude variable
					let list = content.split(/\s+/).map((tag) => tag.trim());
					list = list.filter((tag) => {
						if (tag.match(/^#[\p{L}]+[^#]*$/u)) {
							return true;
						} else {
							return false;
						}
					});
					exclude = list;
				}
			});

			// Create summary only if the user specified some tags
			if (tags.length > 0 || include.length > 0) {
				await this.createSummary(el, tags, include, exclude, ctx.sourcePath);
			} else {
				this.createEmptySummary(el);
			}
		});
	}

	// Show empty summary when the tags are not found
	createEmptySummary(element: HTMLElement) {
		const container = createEl("div");
		container.createEl("span", {
			attr: { style: 'color: var(--text-error) !important;' },
			text: "There are no blocks that match the specified tags."
		});
		element.replaceWith(container);
	}

	includeTag(validTag: string, tagsInFile: TagCache[]) {
		for (let tagF of tagsInFile) {
			if (tagF.tag.startsWith(validTag)) {
				return true;
			}
		}
		return false;
	}

	// Load the blocks and create the summary
	async createSummary(element: HTMLElement, tags: string[], include: string[], exclude: string[], filePath: string) {
		const validTags = tags.concat(include); // All the tags selected by the user

		// Get files
		let listFiles = this.app.vault.getMarkdownFiles();

		// Filter files
		listFiles = listFiles.filter((file) => {
			// Remove files that do not contain the tags selected by the user
			const cache = app.metadataCache.getFileCache(file);
			const { tags, frontmatter } = cache;
			if ((frontmatter && frontmatter["exclude-tag-summary"] == "true") || !tags) {
				return false;
			}

			if (validTags.some((value) => this.includeTag(value, tags))) {
				return true;
			}
			return false;
		});

		// Sort files alphabetically
		listFiles = listFiles.sort((file1, file2) => {
			if (file1.path < file2.path) {
				return -1;
			} else if (file1.path > file2.path) {
				return 1;
			} else {
				return 0;
			}
		});

		// Get files content
		let listContents: FileInfo[] = await this.readFiles(listFiles);

		// Create summary ttt
		let summary: string = "";

		let totalLines: [string, string][] = [];
		listContents.forEach((item) => {
			// Get files name
			const tfile = item[0], content = item[1].split("\n"), cache = item[2];
			const fileName = tfile.name.replace(/.md$/g, ""), filePath = tfile.path;

			// Get paragraphs
			let listLines: [string, string][] = Array();
			// const blocks = item[1].split(/\n\s*\n/).filter((row) => row.trim().length > 0);
			const tagsInFile = cache.tags;

			// 遍历所有 tags, 匹配目标 tag
			tagsInFile.forEach(tagF => {
				for (const vtag of validTags) {
					if (tagF.tag.startsWith(vtag)) {
						// 取出文本
						const startLine = tagF.position.start.line, endline = tagF.position.end.line;
						let targetLine = content[startLine];
						listLines.push([targetLine, tagF.tag]);
					}
				}
			});

			listLines
				.forEach(([line, tagName], index) => {
					// Restore newline at the end
					line += "\n";

					if (this.settings.includelink) {
						let result,
							src = tfile.path,
							alias = fileName;
						if ((result = line.match(this.regex))) {
							let link = result[1].trim();
							src = `${src}#^${link}`;
							alias = `${alias}=>${link}`;
						}
						if ((result = line.match(/\*\*([^*]+?)\*\*/))) {
							alias = result[1].trim();
						}
						line = line + "\n" + `Source: **[[${src}|${alias}]]**\n`;
					}

					// Insert the text in a callout
					if (this.settings.includecallout) {
						let callout = '> [!' + fileName + ']\n';
						const rows = line.split('\n');
						rows.forEach(row => {
							callout += '> ' + row + '\n';
						});
						line = callout + '\n\n';
					} else {
						line += '\n\n';
					}

					listLines[index][0] = line;
					totalLines.push([line, tagName]);
				});
		});

		totalLines
			.sort((a, b) => a[1].localeCompare(b[1]))
			.forEach(([line, tagName]) => {
				summary += line;
			});

		// Add Summary
		if (summary != "") {
			let summaryContainer = createEl("div");
			await MarkdownRenderer.renderMarkdown(summary, summaryContainer, this.app.workspace.getActiveFile()?.path, null);
			element.replaceWith(summaryContainer);
		} else {
			this.createEmptySummary(element);
		}
	}

	// Read Files
	async readFiles(listFiles: TFile[]): Promise<FileInfo[]> {
		let list: FileInfo[] = [];
		for (let t = 0; t < listFiles.length; t += 1) {
			const file = listFiles[t];
			let content = await this.app.vault.cachedRead(file);
			let cache = this.app.metadataCache.getCache(file.path);
			list.push([file, content, cache]);
		}
		return list;
	}

	// Check if tags are valid
	isValidText(listTags: TagCache[], tags: string[], include: string[], exclude: string[]): boolean {
		let valid = true;

		// Check OR (tags)
		if (tags.length > 0) {
			valid = valid && tags.some((value) => this.includeTag(value, listTags));
		}
		// Check AND (include)
		if (include.length > 0) {
			valid = valid && include.every((value) => this.includeTag(value, listTags));
		}
		// Check NOT (exclude)
		if (valid && exclude.length > 0) {
			valid = !exclude.some((value) => this.includeTag(value, listTags));
		}
		return valid;
	}

	// Settings
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

