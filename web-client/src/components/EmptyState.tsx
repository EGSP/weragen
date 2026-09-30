import { RobotOutlined } from '@ant-design/icons';
import { Welcome } from '@ant-design/x';
import { Flex, Tag, Typography, theme } from 'antd';
import { useTools } from '../api/queries.js';

export function EmptyState() {
    const { token } = theme.useToken();
    const { data: tools } = useTools();

    return (
        <Flex align="center" justify="center" style={{ flex: 1, padding: token.paddingLG }}>
            <Flex vertical gap={token.margin} style={{ maxWidth: 620 }}>
                <Welcome
                    icon={<RobotOutlined style={{ fontSize: 32 }} />}
                    title="Выберите сессию или создайте новую"
                    description="Агент отвечает на вопросы и выполняет действия через инструменты. Ход работы виден по шагам."
                    variant="borderless"
                />

                {tools !== undefined && tools.length > 0 ? (
                    <Flex vertical gap={token.marginXS}>
                        <Typography.Text type="secondary">Доступные инструменты</Typography.Text>
                        <Flex wrap gap={token.marginXXS}>
                            {tools.map((tool) => (
                                <Tag key={tool.name} variant="filled">
                                    {tool.name}
                                </Tag>
                            ))}
                        </Flex>
                    </Flex>
                ) : null}
            </Flex>
        </Flex>
    );
}
