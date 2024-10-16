import * as path from 'path'
import * as vscode from 'vscode'
import getNonce from './getNonce'
import { Kanbn } from '@basementuniverse/kanbn/src/main'

function transformTaskData (
  taskData: any,
  customFields: Array<{ name: string, type: 'boolean' | 'date' | 'number' | 'string' }>
): any {
  const result = {
    id: taskData.id,
    name: taskData.name,
    description: taskData.description,
    metadata: {
      created: new Date(taskData.createdDate ?? new Date()),
      updated: new Date(),
      assigned: taskData.assignedTo,
      progress: Number(taskData.progress),
      tags: taskData.tags.map((tag: any) => tag.tag)
    } as any,
    relations: taskData.relations ?? [],
    subTasks: taskData.subTasks ?? [],
    comments: taskData.comments ?? []
  } as any
  for (const comment of result.comments) {
    comment.date = new Date(comment.date)
  }

  // Add due, started and completed dates if present
  if (taskData.dueDate !== null) {
    result.metadata.due = new Date(taskData.dueDate)
    if (!(result.metadata.due instanceof Date) || isNaN(result.metadata.due.getTime())) {
      delete result.metadata.due
    }
  }
  if (taskData.startedDate !== null) {
    result.metadata.started = new Date(taskData.startedDate)
    if (!(result.metadata.started instanceof Date) || isNaN(result.metadata.started.getTime())) {
      delete result.metadata.started
    }
  }
  if (taskData.completedDate !== null) {
    result.metadata.completed = new Date(taskData.completedDate)
    if (!(result.metadata.completed instanceof Date) || isNaN(result.metadata.completed.getTime())) {
      delete result.metadata.completed
    }
  }

  // Add custom fields
  for (const customField of taskData.customFields) {
    result.metadata[customField.name] = customField.value
    if (customField.type === 'date' && customField.value != null) {
      result.metadata[customField.name] = new Date(customField.value)
      if (!(result.metadata[customField.name] instanceof Date) || isNaN(result.metadata[customField.name].getTime())) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete result.metadata[customField.name]
      }
    }
    if (customField.type === 'boolean' && customField.value === false) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete result.metadata[customField.name]
    }
    if (customField.type === 'number' && customField.value === '') {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete result.metadata[customField.name]
    }
  }

  return result
}

export default class KanbnTaskPanel {
  private static readonly viewType = 'KanbnTaskPanel'

  private readonly _panel: vscode.WebviewPanel
  private readonly _extensionPath: string
  private readonly _workspacePath: string
  private readonly _kanbn: Kanbn
  private readonly _kanbnFolderName: string
  private _taskId: string | symbol
  private readonly _defaultColumn: string | null
  private readonly _disposables: vscode.Disposable[] = []
  private fileWatcher: vscode.FileSystemWatcher | undefined

  public async show (): Promise<void> {
    void this.update()
    this._panel.reveal()
  }

  public sendSaveRequest (): void {
    void this._panel?.webview.postMessage({ command: 'saveRequest' })
  }

  constructor (
    extensionPath: string,
    workspacePath: string,
    kanbn: Kanbn,
    kanbnFolderName: string,
    taskId: string | symbol,
    defaultColumn: string | null,
    taskCache: Map<string | symbol, KanbnTaskPanel>
  ) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One
    this._extensionPath = extensionPath
    this._workspacePath = workspacePath
    this._kanbn = kanbn
    this._kanbnFolderName = kanbnFolderName
    this._taskId = taskId
    this._defaultColumn = defaultColumn

    // Create and show a new webview panel
    this._panel = this.createWebviewPanel(column)
    this.updateFileWatcher()

    if (this._taskId !== null) {
      this._panel.onDidDispose((e) => { if (this._taskId !== null) taskCache.delete(this._taskId) })
    }

    (this._panel as any).iconPath = {
      light: vscode.Uri.file(path.join(this._extensionPath, 'resources', 'task_light.svg')),
      dark: vscode.Uri.file(path.join(this._extensionPath, 'resources', 'task_dark.svg'))
    }

    // Set the webview's title to the kanbn task name
    if (typeof this._taskId === 'string') {
      void this._kanbn.getTask(this._taskId).then((task) => {
        this._panel.title = task.name
      })
    }

    // Set the webview's initial html content
    this._panel.webview.html = this._getHtmlForWebview()

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          // Display error message
          case 'error':
            void vscode.window.showErrorMessage(message.text)
            return

          // Update panel once it's loaded
          case 'kanbn.updateMe':
            void this.update()
            return

          // Create a task
          case 'kanbn.updateOrCreate':
            if (typeof this._taskId === 'symbol') {
              await this._kanbn.createTask(
                transformTaskData(message.taskData, message.customFields),
                message.taskData.column
              )
              this._panel.onDidDispose((e) => { if (this._taskId !== null) taskCache.delete(this._taskId) })
              taskCache.delete(this._taskId)
              taskCache.set(message.taskData.id, this)
              void this.update()
              if (vscode.workspace.getConfiguration('kanbn').get<boolean>('showTaskNotifications') ?? true) {
                // TODO: remove the explicit String cast once typescript bindings for kanbn are updated
                void vscode.window.showInformationMessage(`Created task '${String(message.taskData.name)}'.`)
              }
            } else {
              await this._kanbn.updateTask(
                this._taskId,
                transformTaskData(message.taskData, message.customFields),
                message.taskData.column
              )

              if (vscode.workspace.getConfiguration('kanbn').get<boolean>('showTaskNotifications') ?? true) {
                // TODO: remove the explicit String cast once typescript bindings for kanbn are updated
                void vscode.window.showInformationMessage(`Updated task '${String(message.taskData.name)}'.`)
              }
            }
            if (this._taskId !== message.taskData.id) {
              taskCache.set(message.taskData.id, this)
              taskCache.delete(this._taskId ?? '')
              this._taskId = message.taskData.id
              this.updateFileWatcher()
            }
            this._panel.title = message.taskData.name
            return

          // Delete a task and close the webview panel
          case 'kanbn.delete': {
            const deleteTaskId = this._taskId
            if (typeof deleteTaskId !== 'string') return

            const taskName: string = (await this._kanbn.getTask(deleteTaskId)).name
            void vscode.window
              .showInformationMessage(`Delete task '${taskName}'?`, 'Yes', 'No')
              .then(async (value) => {
                if (value === 'Yes') {
                  await this._kanbn.deleteTask(deleteTaskId, true)
                  this.dispose()
                  if (vscode.workspace.getConfiguration('kanbn').get<boolean>('showTaskNotifications') ?? true) {
                    void vscode.window.showInformationMessage(`Deleted task '${taskName}'.`)
                  }
                }
              })
            return
          }

          // Archive a task and close the webview panel
          case 'kanbn.archive': {
            if (typeof this._taskId !== 'string') return

            const taskName: string = (await this._kanbn.getTask(this._taskId ?? '')).name
            if (this._taskId !== null) await this._kanbn.archiveTask(this._taskId)
            this.dispose()
            if (vscode.workspace.getConfiguration('kanbn').get<boolean>('showTaskNotifications') ?? true) {
              // TODO: remove the explicit String cast once typescript bindings for kanbn are updated
              void vscode.window.showInformationMessage(`Archived task '${taskName}'.`)
            }
          }
        }
      },
      null,
      this._disposables
    )
  }

  private createWebviewPanel (column: vscode.ViewColumn): vscode.WebviewPanel {
    return vscode.window.createWebviewPanel(KanbnTaskPanel.viewType, 'New task', column, {
      // Enable javascript in the webview
      enableScripts: true,

      // Restrict the webview to only loading content from allowed paths
      localResourceRoots: [
        vscode.Uri.file(path.join(this._extensionPath, 'build')),
        vscode.Uri.file(path.join(this._kanbnFolderName, '.kanbn'))
      ]
    })
  }

  public dispose (): void {
    this._panel.dispose()
    while (this._disposables.length > 0) {
      const x = this._disposables.pop()
      if (x != null) {
        x.dispose()
      }
    }
  }

  private getTaskFilename (): string | undefined {
    if (typeof this._taskId !== 'string') return

    const folderPath = path.join(this._kanbnFolderName, '.kanbn')
    const taskFilename = this._taskId.replace(/(?<!\.md)$/, '.md')
    const taskPath = path.join(folderPath, 'tasks', taskFilename)

    return taskPath
  }

  private updateFileWatcher (): void {
    this.fileWatcher?.dispose()
    if (this._panel === undefined) return

    const taskPath = this.getTaskFilename()
    if (taskPath === undefined) return

    this.fileWatcher = vscode.workspace.createFileSystemWatcher(taskPath)
    this._panel.onDidDispose(() => this.fileWatcher?.dispose())

    this.fileWatcher.onDidChange(() => {
      void this.update()
    })
  }

  public async showTaskFilePanel (): Promise<void> {
    const taskPath = this.getTaskFilename()

    if (taskPath === undefined) return

    const taskfileEditor = vscode.workspace.getConfiguration('kanbn').get<boolean>('taskfileEditor')
    try {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(taskPath), taskfileEditor)
    } catch {
      const textDoc = await vscode.workspace.openTextDocument(taskPath)
      await vscode.window.showTextDocument(textDoc)
    }
  }

  public getTaskId (): string | symbol {
    return this._taskId
  }

  public getCurrentTaskTitle (): string {
    return this._panel.title
  }

  public isActive (): boolean {
    try {
      return this._panel.active
    } catch {
      return false
    }
  }

  private async _getTaskData (): Promise<any> {
    let index: any
    try {
      index = await this._kanbn.getIndex()
    } catch (error) {
      if (error instanceof Error) {
        void vscode.window.showErrorMessage(error.message)
      } else {
        throw error
      }
      return
    }
    let tasks: any[]
    try {
      tasks = (await this._kanbn.loadAllTrackedTasks(index)).map((task) => ({
        ...this._kanbn.hydrateTask(index, task)
      }))
    } catch (error) {
      if (error instanceof Error) {
        void vscode.window.showErrorMessage(error.message)
      } else {
        throw error
      }
      return
    }
    let task: any = null
    if (this._taskId !== null) {
      task = tasks.find((t) => t.id === this._taskId) ?? null
      await this.loadOtherTaskData(task)
    }

    // Use column of task, or first column if task doesn't exist yet.
    const columnName = task?.column ?? this._defaultColumn ?? Object.keys(index.columns)[0]

    // Send task data to the webview
    return {
      index,
      task,
      tasks,
      customFields: index.options.customFields ?? [],
      columnName,
      dateFormat: this._kanbn.getDateFormat(index)
    }
  }

  private async loadOtherTaskData (task?: any): void {
    if (typeof task?.id !== 'string') return

    try {
      const finishedPomodoros: number | undefined = await vscode.commands.executeCommand('pomodoro.getFinishedTasksCount', task.id)

      if (typeof finishedPomodoros === 'number') {
        task.finishedPomodoros = finishedPomodoros
      }
    } catch (e) {
    }
  }

  private async update (): Promise<void> {
    // Send task data to the webview
    void this._panel.webview.postMessage(await this._getTaskData())
  }

  private _getHtmlForWebview (): string {
    const mainScript = path.join('static', 'index.js')
    const mainStyle = path.join('static', 'index.css')
    if (this._panel === null) {
      throw new Error('Panel is not defined')
    }
    const webview = this._panel.webview
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionPath, 'build', mainScript)))

    const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionPath, 'build', mainStyle)))

    const customStyleUri = webview.asWebviewUri(vscode.Uri.file(
      path.join(this._kanbnFolderName, '.kanbn', 'board.css')
    ))

    // Use a nonce to whitelist which scripts can be run
    const nonce = getNonce()

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
<meta name="theme-color" content="#000000">
<title>Kanbn Board</title>
<link rel="stylesheet" type="text/css" href="${styleUri.toString()}">
<link rel="stylesheet" type="text/css" href="${customStyleUri.toString()}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-webview-resource: https:; script-src 'nonce-${nonce}'; font-src vscode-webview-resource:; style-src vscode-webview-resource: 'unsafe-inline' http: https: data:;">
<base href="${webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionPath, 'build'))).toString()}/">
</head>
<body>
<noscript>You need to enable JavaScript to run this app.</noscript>
<div id="root-task"></div>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`
  }
}
