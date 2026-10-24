const SQLiteDatabase = require('../src/sqliteDatabase');
const { parseTagCommand, runTagCommand } = require('../src/cliTagCommand');

describe('parseTagCommand', () => {
  test('沒有 --add-tag 回傳 null', () => {
    expect(parseTagCommand(['--dev'])).toBeNull();
    expect(parseTagCommand(['C:\\v\\a.mp4'])).toBeNull();
    expect(parseTagCommand(['--add-tag=  '])).toBeNull();
  });

  test('取出標籤、群組與檔案（忽略其他參數、重複檔案）', () => {
    const cmd = parseTagCommand([
      '--add-tag=中文', '--tag-group=字幕', '--allow-file-access-from-files',
      '\\\\nas\\d\\a.mp4', 'C:\\v\\b c.mkv', '\\\\nas\\d\\a.mp4'
    ]);
    expect(cmd).toEqual({ tagName: '中文', groupName: '字幕', files: ['\\\\nas\\d\\a.mp4', 'C:\\v\\b c.mkv'] });
  });
});

describe('runTagCommand', () => {
  let db;

  beforeEach(async () => {
    db = new SQLiteDatabase(':memory:');
    await db.init();
  });

  afterEach(() => db.close());

  const addVideo = (filepath, fingerprint) => db.addVideo({
    filename: filepath.split('\\').pop(), filepath, filesize: 1, fingerprint, file_created_at: new Date()
  });

  const tagsOf = async (filepath) => {
    const { fingerprint } = await db.getVideoByPath(filepath);
    return db.db.prepare('SELECT tag_name FROM video_tags WHERE fingerprint = ?').all(fingerprint).map(r => r.tag_name);
  };

  test('已有標籤的不重複加，資料庫沒有的影片先加入再標記', async () => {
    await addVideo('C:\\v\\a.mp4', 'fp-a');
    await addVideo('C:\\v\\b.mp4', 'fp-b');
    await db.addVideoTag('fp-b', '中文');

    const importFiles = jest.fn(async (files) => {
      for (const f of files) await addVideo(f, 'fp-new');
    });
    const result = await runTagCommand(db, {
      tagName: '中文', groupName: '字幕', files: ['C:\\v\\a.mp4', 'C:\\v\\b.mp4', 'C:\\v\\new.mp4']
    }, importFiles);

    expect(importFiles).toHaveBeenCalledWith(['C:\\v\\new.mp4']);
    expect(result).toEqual({ added: 2, alreadyTagged: 1, imported: 1, notFound: [] });
    expect(await tagsOf('C:\\v\\a.mp4')).toContain('中文');
    expect(await tagsOf('C:\\v\\new.mp4')).toContain('中文');
  });

  test('標籤不存在時建在指定群組；已存在則沿用原本的群組', async () => {
    await addVideo('C:\\v\\a.mp4', 'fp-a');
    await runTagCommand(db, { tagName: '中文', groupName: '字幕', files: ['C:\\v\\a.mp4'] }, async () => {});
    let groups = await db.getTagsByGroup();
    const subGroup = groups.find(g => g.name === '字幕');
    expect(subGroup.tags.map(t => t.name)).toEqual(['中文']);

    const otherId = await db.createTagGroup({ name: '語言' });
    await db.createTag({ name: '英文', group_id: otherId });
    await runTagCommand(db, { tagName: '英文', groupName: '字幕', files: ['C:\\v\\a.mp4'] }, async () => {});
    groups = await db.getTagsByGroup();
    expect(groups.find(g => g.name === '字幕').tags.map(t => t.name)).toEqual(['中文']);
  });

  test('加不進資料庫的檔案回報在 notFound', async () => {
    const result = await runTagCommand(db, { tagName: '中文', groupName: '', files: ['C:\\v\\gone.mp4'] }, async () => {});
    expect(result).toEqual({ added: 0, alreadyTagged: 0, imported: 0, notFound: ['C:\\v\\gone.mp4'] });
  });
});
