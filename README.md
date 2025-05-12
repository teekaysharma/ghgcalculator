# GHG Emissions Calculator

A comprehensive tool for tracking and analyzing Scope 1, 2, and 3 carbon emissions with support for advanced features like multi-year comparisons, product intensity metrics, and waste management tracking.

## Features

- **Multi-Scope Emissions Tracking**: Calculate and track Scope 1, 2, and 3 greenhouse gas emissions
- **Multi-Year Comparison**: Track and visualize emissions trends over time
- **Product Intensity Metrics**: Calculate emissions per unit of production for various products
- **Waste Analysis**: Track emissions by waste type and disposal method
- **Flexible Data Import**: Support for various Excel file formats and column naming conventions
- **Visualization**: Charts and graphs for emissions data analysis

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

### Installation

1. Unzip the downloaded file to a directory of your choice
2. Open a terminal/command prompt and navigate to the project directory
3. Install dependencies:

```bash
npm install
```

or if you use yarn:

```bash
yarn
```

### Running the Application

To start the development server:

```bash
npm run dev
```

This will launch both the backend server and the frontend application. The application will be available at `http://localhost:5000` in your web browser.

### Using the Application

1. **Upload Emission Factors**: Use the "Upload Emission Factors" section to import your Excel file with emission factors
2. **Enter Activity Data**: Enter your activity data in the appropriate scope tabs
3. **View Results**: The Results section will display your calculated emissions and visualizations

## Emission Factor File Format

The application supports various emission factor file formats:

1. **Standard format**: A simple table with columns for Activity Type, Emission Factor, and Unit
2. **Multi-scope format**: Data organized by scope (1, 2, or 3) using sheet names or a Scope column
3. **Waste-specific format**: Detailed tracking of waste types and disposal methods

For detailed format instructions, click the "Waste Factor Format Guide" button in the application.

## Support

For questions or issues, please contact the development team.

## License

This project is licensed under the MIT License.