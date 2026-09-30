import type { ReactNode } from 'react';
import {
    ApartmentOutlined,
    ApiOutlined,
    DeploymentUnitOutlined,
    MessageOutlined,
} from '@ant-design/icons';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Flex, Layout as AntLayout, Menu, Typography, theme } from 'antd';
import { SessionList } from './SessionList.js';

const { Sider, Content } = AntLayout;

/**
 * Оболочка приложения.
 *
 * Слева — меню платформы, справа — список сессий текущего раздела. Разделение намеренное:
 * слева находится то, что не меняется от раздела к разделу, справа — содержимое текущего
 * раздела. Поэтому на странице моделей правая панель не показывается, а в разделе воркфлоу
 * тот же список отбирает исполнения вместо чатов.
 *
 * Высота фиксирована окном, прокрутка отдана внутренним областям.
 */
export function Layout({ children }: { readonly children: ReactNode }) {
    const { token } = theme.useToken();
    const navigate = useNavigate();
    const pathname = useRouterState({ select: (state) => state.location.pathname });

    const inWorkflows = pathname.startsWith('/workflows');
    const inMcp = pathname.startsWith('/mcp');
    const inSessions = !inWorkflows && !inMcp && (pathname === '/' || pathname.startsWith('/sessions'));
    const selectedKey = inWorkflows
        ? 'workflows'
        : inMcp
          ? 'mcp'
          : inSessions
            ? 'sessions'
            : 'models';

    const surface = {
        background: token.colorBgContainer,
    } as const;

    return (
        <AntLayout hasSider style={{ height: '100dvh' }}>
            <Sider
                theme="light"
                width={216}
                collapsedWidth={0}
                breakpoint="md"
                trigger={null}
                style={{
                    ...surface,
                    overflow: 'hidden',
                    borderInlineEnd: `1px solid ${token.colorBorderSecondary}`,
                }}
            >
                <Flex
                    align="baseline"
                    gap={token.marginXS}
                    style={{ padding: `${token.padding}px ${token.padding}px 0` }}
                >
                    <Typography.Title level={5} style={{ margin: 0 }}>
                        weragen
                    </Typography.Title>
                    <Typography.Text type="secondary">Агентская платформа</Typography.Text>
                </Flex>

                <Menu
                    mode="inline"
                    selectedKeys={[selectedKey]}
                    style={{ borderInlineEnd: 'none', marginBlockStart: token.margin }}
                    onClick={({ key }) =>
                        void navigate({
                            to:
                                key === 'models'
                                    ? '/models'
                                    : key === 'workflows'
                                      ? '/workflows'
                                      : key === 'mcp'
                                        ? '/mcp'
                                        : '/',
                        })
                    }
                    items={[
                        { key: 'sessions', icon: <MessageOutlined />, label: 'Чаты' },
                        { key: 'workflows', icon: <ApartmentOutlined />, label: 'Воркфлоу' },
                        { key: 'mcp', icon: <DeploymentUnitOutlined />, label: 'Подключения MCP' },
                        { key: 'models', icon: <ApiOutlined />, label: 'Модели' },
                    ]}
                />
            </Sider>

            <AntLayout>
                <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    {children}
                </Content>
            </AntLayout>

            {inSessions || inWorkflows ? (
                <Sider
                    theme="light"
                    width={288}
                    collapsedWidth={0}
                    breakpoint="lg"
                    trigger={null}
                    style={{
                        ...surface,
                        overflow: 'hidden',
                        borderInlineStart: `1px solid ${token.colorBorderSecondary}`,
                    }}
                >
                    <SessionList kind={inWorkflows ? 'workflow' : 'chat'} />
                </Sider>
            ) : null}
        </AntLayout>
    );
}
